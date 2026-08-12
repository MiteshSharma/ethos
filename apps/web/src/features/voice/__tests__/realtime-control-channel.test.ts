import type {
  RealtimeSocket,
  RealtimeSocketFactory,
  RealtimeSocketHandlers,
  RealtimeSocketInit,
} from '@ethosagent/voice-realtime-protocol';
import type { VoiceClientFrame, VoiceServerFrame } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  createRealtimeVoiceCallClient,
  type RealtimeSessionTicket,
} from '../realtime-voice-call-client';
import type { VoiceCallEvent } from '../voice-call-client';
import type { VoiceTransport, VoiceTransportStatus } from '../voice-socket-transport';
import { FakePlayout, FakeVoiceCapture } from './streaming-fakes';

// The realtime tier's CONTROL channel, from the browser's side. Two sockets:
// the provider's (media) and the app's (control). This file is about the second
// one — what the browser relays onto it, and what it does with what comes back.
//
// The browser decides nothing here. It runs no tool, chooses no words, and does
// not know its own lane key until the server names it. Every assertion below is
// a relay assertion for that reason.

class FakeProviderSocket {
  readonly sent: unknown[] = [];
  init: RealtimeSocketInit | undefined;
  private handlers: RealtimeSocketHandlers | undefined;

  readonly factory: RealtimeSocketFactory = (init, handlers): RealtimeSocket => {
    this.init = init;
    this.handlers = handlers;
    queueMicrotask(() => handlers.onOpen());
    return {
      send: (data: string) => {
        this.sent.push(JSON.parse(data));
      },
      close: () => {},
    };
  };

  deliver(frame: unknown): void {
    this.handlers?.onMessage(JSON.stringify(frame));
  }
}

/** The app's voice socket, under the test's control from both ends. */
class FakeControlTransport implements VoiceTransport {
  readonly sent: VoiceClientFrame[] = [];
  status: VoiceTransportStatus = 'closed';
  private listeners = new Set<(frame: VoiceServerFrame, payload: Uint8Array) => void>();

  async connect(): Promise<void> {
    this.status = 'open';
  }
  send(frame: VoiceClientFrame): void {
    this.sent.push(frame);
  }
  on(listener: (frame: VoiceServerFrame, payload: Uint8Array) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onStatus(): () => void {
    return () => {};
  }
  close(): void {
    this.status = 'closed';
  }
  /** Server → browser. */
  deliver(frame: VoiceServerFrame): void {
    for (const listener of [...this.listeners]) listener(frame, new Uint8Array(0));
  }
}

const TICKET: RealtimeSessionTicket = {
  providerId: 'openai-realtime',
  model: 'gpt-realtime',
  token: 'ek_test',
  expiresAt: Date.now() + 60_000,
  url: 'wss://api.openai.com/v1/realtime',
  inputSampleRate: 16_000,
  outputSampleRate: 24_000,
};

function setup(
  opts: {
    control?: FakeControlTransport | null;
    chatSessionId?: string;
    ticket?: RealtimeSessionTicket;
    windDownGraceMs?: number;
  } = {},
) {
  const socket = new FakeProviderSocket();
  const control = opts.control === null ? null : (opts.control ?? new FakeControlTransport());
  const events: VoiceCallEvent[] = [];
  const playout = new FakePlayout();
  const client = createRealtimeVoiceCallClient({
    session: opts.ticket ?? TICKET,
    capture: new FakeVoiceCapture(),
    playout,
    socketFactory: socket.factory,
    chime: false,
    ...(control ? { control } : {}),
    personalityId: 'ada',
    chatSessionId: () => opts.chatSessionId ?? 'chat-9',
    ...(opts.windDownGraceMs !== undefined ? { windDownGraceMs: opts.windDownGraceMs } : {}),
  });
  client.on((event) => events.push(event));
  return { socket, control, events, client, playout };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const OPEN = { type: 'session.created', session: { id: 'sess_1', model: 'gpt-realtime' } };

function audioFrame(bytes: number[]): unknown {
  return { type: 'response.output_audio.delta', delta: btoa(String.fromCharCode(...bytes)) };
}

describe('control channel — opening', () => {
  it('declares the call, its chat session and whether the provider can speak verbatim', async () => {
    const { control, client } = setup();
    await client.connect();

    expect(control?.sent).toEqual([
      {
        t: 'realtime_start',
        // OpenAI's codec has `encodeSay`, so the session exposes `say()`.
        canSay: true,
        sessionId: 'chat-9',
        personalityId: 'ada',
      },
    ]);
    await client.disconnect();
  });

  it('runs without a control channel — degraded, not broken', async () => {
    // No control channel means the session was minted with no tools either, so
    // a tool call is unreachable rather than dropped. It must still not throw.
    const { client, socket, events } = setup({ control: null });
    await client.connect();
    socket.deliver(OPEN);
    socket.deliver({
      type: 'response.function_call_arguments.done',
      call_id: 'call_1',
      name: 'agent_consult',
      arguments: '{}',
    });
    await settle();

    expect(events).toContainEqual({ type: 'link', status: 'open' });
    expect(socket.sent).toEqual([]);
    await client.disconnect();
  });
});

describe('control channel — tool calls are relayed, never run here', () => {
  it('forwards a provider tool call verbatim and answers with the server’s result', async () => {
    const { socket, control, client } = setup();
    await client.connect();
    socket.deliver(OPEN);
    socket.deliver({
      type: 'response.function_call_arguments.done',
      call_id: 'call_1',
      name: 'agent_consult',
      arguments: JSON.stringify({ prompt: 'what did we decide?' }),
    });
    await settle();

    expect(control?.sent).toContainEqual({
      t: 'realtime_tool_call',
      callId: 'call_1',
      name: 'agent_consult',
      args: { prompt: 'what did we decide?' },
    });
    // Nothing was answered until the server said so.
    expect(socket.sent).toEqual([]);

    control?.deliver({
      t: 'realtime_tool_result',
      callId: 'call_1',
      ok: true,
      output: 'Friday.',
    });
    await settle();

    expect(socket.sent).toContainEqual({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: 'call_1', output: 'Friday.' },
    });
    await client.disconnect();
  });
});

describe('control channel — filler', () => {
  it('speaks the server’s line through the provider and captions it', async () => {
    const { socket, control, client } = setup();
    await client.connect();
    socket.deliver(OPEN);
    await settle();
    socket.sent.length = 0;

    control?.deliver({ t: 'realtime_speak', text: 'Let me check.', kind: 'ack' });
    await settle();

    expect(socket.sent).toContainEqual({
      type: 'response.create',
      response: {
        output_modalities: ['audio'],
        instructions: 'Say exactly this to the user, verbatim, adding nothing: Let me check.',
      },
    });
    await client.disconnect();
  });

  it('always captions the line, so a consult is visible and not dead air', async () => {
    const { control, client, events, socket } = setup();
    await client.connect();
    socket.deliver(OPEN);
    await settle();

    control?.deliver({ t: 'realtime_speak', text: 'One moment.', kind: 'filler' });
    await settle();

    expect(events).toContainEqual({ type: 'filler', text: 'One moment.' });
    await client.disconnect();
  });

  it('never re-reports the line it asked for as the model’s reply', async () => {
    // The provider echoes a `say()` back through the ordinary reply events. Left
    // alone it would duplicate the filler in the transcript, persist "Let me
    // check." as an assistant turn, and drop the strip out of `consulting` a few
    // hundred ms after it entered — for a wait that can run for seconds.
    const { socket, control, client, events, playout } = setup();
    await client.connect();
    socket.deliver(OPEN);
    await settle();
    const before = control?.sent.length ?? 0;

    control?.deliver({ t: 'realtime_speak', text: 'Let me check.', kind: 'ack' });
    await settle();
    socket.deliver({ type: 'response.output_audio_transcript.delta', delta: 'Let me check. ' });
    socket.deliver(audioFrame([1, 0]));
    socket.deliver({ type: 'response.done' });
    await settle();

    expect(events.filter((e) => e.type === 'filler')).toHaveLength(1);
    expect(events.some((e) => e.type === 'reply_sentence')).toBe(false);
    expect(events.some((e) => e.type === 'reply_complete')).toBe(false);
    expect(control?.sent.slice(before).filter((f) => f.t === 'realtime_transcript')).toEqual([]);
    // Still HEARD, though — suppressing the reply framing must not mute it.
    expect(playout.pcm).toHaveLength(1);
    await client.disconnect();
  });

  it('reports the reply that follows a filler normally', async () => {
    // The suppression is scoped to the filler's own response; the answer the
    // consult was waiting for is an ordinary reply again.
    const { socket, control, client, events } = setup();
    await client.connect();
    socket.deliver(OPEN);
    await settle();

    control?.deliver({ t: 'realtime_speak', text: 'Let me check.', kind: 'ack' });
    await settle();
    socket.deliver({ type: 'response.done' });
    await settle();

    socket.deliver({ type: 'response.output_audio_transcript.delta', delta: 'It was Friday. ' });
    socket.deliver({ type: 'response.done' });
    await settle();

    expect(events).toContainEqual({ type: 'reply_complete', text: 'It was Friday.' });
    expect(control?.sent).toContainEqual({
      t: 'realtime_transcript',
      role: 'assistant',
      text: 'It was Friday.',
    });
    await client.disconnect();
  });

  it('degrades on a provider with no verbatim-speech frame: captioned, not spoken', async () => {
    // Gemini Live's codec omits `encodeSay`, so the session omits `say()`. The
    // browser declares `canSay: false` — the server then sends the ack once and
    // stops repeating — and the line is captioned rather than voiced. The
    // audible half is covered by the boundary policy, which tells the model to
    // announce the check itself before it calls the tool.
    const { control, client, events, socket } = setup({
      ticket: { ...TICKET, providerId: 'gemini-live', inputSampleRate: 16_000 },
    });
    await client.connect();
    await settle();

    expect(control?.sent[0]).toMatchObject({ t: 'realtime_start', canSay: false });

    socket.sent.length = 0;
    control?.deliver({ t: 'realtime_speak', text: 'One moment.', kind: 'ack' });
    await settle();

    expect(events).toContainEqual({ type: 'filler', text: 'One moment.' });
    expect(socket.sent).toEqual([]);
    await client.disconnect();
  });
});

describe('control channel — transcripts', () => {
  it('sends the settled transcript for both roles, and no partials', async () => {
    const { socket, control, client } = setup();
    await client.connect();
    socket.deliver(OPEN);
    await settle();
    const before = control?.sent.length ?? 0;

    socket.deliver({
      type: 'conversation.item.input_audio_transcription.delta',
      delta: 'what did ',
    });
    socket.deliver({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'what did we decide?',
    });
    socket.deliver({ type: 'response.output_audio_transcript.done', transcript: 'Friday.' });
    socket.deliver({ type: 'response.done', response: { id: 'r1' } });
    await settle();

    expect(control?.sent.slice(before)).toEqual([
      { t: 'realtime_transcript', role: 'user', text: 'what did we decide?' },
      { t: 'realtime_transcript', role: 'assistant', text: 'Friday.' },
    ]);
    await client.disconnect();
  });

  it('persists the spoken prefix on barge-in, marked [interrupted]', async () => {
    // On a conversational tier barge-in is the COMMON case. Leaving the write to
    // `response_done` — whose `replyText` the barge-in has already cleared —
    // silently drops most of the assistant's history from the session.
    const { socket, control, client } = setup();
    await client.connect();
    socket.deliver(OPEN);
    await settle();
    const before = control?.sent.length ?? 0;

    socket.deliver({ type: 'response.output_audio_transcript.delta', delta: 'Sentence one. ' });
    socket.deliver({ type: 'input_audio_buffer.speech_started' });
    await settle();

    expect(control?.sent.slice(before)).toEqual([
      { t: 'realtime_transcript', role: 'assistant', text: 'Sentence one. [interrupted]' },
    ]);
    await client.disconnect();
  });

  it('writes a barged-in turn exactly once, whatever the provider streams after', async () => {
    // `response.cancel` is a request, not a stop: transcript and audio keep
    // arriving for a few frames. None of it was heard, so none of it may be
    // captioned, played, or persisted as a second version of the same turn.
    const { socket, control, client, events, playout } = setup();
    await client.connect();
    socket.deliver(OPEN);
    await settle();
    const before = control?.sent.length ?? 0;

    socket.deliver({ type: 'response.output_audio_transcript.delta', delta: 'Sentence one. ' });
    socket.deliver({ type: 'input_audio_buffer.speech_started' });
    await settle();
    const playedBefore = playout.pcm.length;

    socket.deliver({ type: 'response.output_audio_transcript.delta', delta: 'Sentence two. ' });
    socket.deliver(audioFrame([1, 0]));
    socket.deliver({ type: 'response.done' });
    await settle();

    expect(control?.sent.slice(before)).toEqual([
      { t: 'realtime_transcript', role: 'assistant', text: 'Sentence one. [interrupted]' },
    ]);
    expect(events.some((e) => e.type === 'reply_complete')).toBe(false);
    expect(playout.pcm).toHaveLength(playedBefore);
    await client.disconnect();
  });
});

describe('control channel — budget wind-down', () => {
  it('says the sign-off, then ends the call when it has been said', async () => {
    const { socket, control, client, events } = setup();
    await client.connect();
    socket.deliver(OPEN);
    await settle();
    socket.sent.length = 0;

    control?.deliver({
      t: 'realtime_wind_down',
      text: "That's the limit for this call.",
      reason: 'budget',
    });
    await settle();

    // Captioned AND spoken — and the call is still up while it is being said.
    expect(events).toContainEqual({
      type: 'budget_wind_down',
      text: "That's the limit for this call.",
    });
    expect(socket.sent).toContainEqual({
      type: 'response.create',
      response: {
        output_modalities: ['audio'],
        instructions:
          "Say exactly this to the user, verbatim, adding nothing: That's the limit for this call.",
      },
    });
    expect(events.some((e) => e.type === 'disconnected')).toBe(false);

    // The provider finishes the utterance — THAT is the clean close.
    socket.deliver({ type: 'response.output_audio_transcript.done', transcript: 'said it' });
    socket.deliver({ type: 'response.done', response: { id: 'r1' } });
    await settle();

    expect(events.at(-1)).toEqual({ type: 'disconnected' });
  });

  it('ends immediately on a provider that cannot speak the line', async () => {
    // Gemini Live: no verbatim-speech frame, so there is no utterance to wait
    // for. The sentence is still captioned — the listener sees why it ended.
    const { client, control, events } = setup({
      ticket: { ...TICKET, providerId: 'gemini-live' },
    });
    await client.connect();
    await settle();

    control?.deliver({ t: 'realtime_wind_down', text: 'Out of budget.', reason: 'budget' });
    await settle();

    expect(events).toContainEqual({ type: 'budget_wind_down', text: 'Out of budget.' });
    expect(events.at(-1)).toEqual({ type: 'disconnected' });
  });

  it('ends the call anyway when the provider never reports the line finished', async () => {
    // The backstop. Without it a budget-halted session sits open on a paid
    // socket — the exact opposite of what a budget halt is for.
    const { client, control, events, socket } = setup({ windDownGraceMs: 0 });
    await client.connect();
    socket.deliver(OPEN);
    await settle();

    control?.deliver({ t: 'realtime_wind_down', text: 'Out of budget.', reason: 'budget' });
    await settle();
    await settle();

    expect(events.at(-1)).toEqual({ type: 'disconnected' });
  });
});

describe('control channel — hangup', () => {
  it('ends the control lane before the sockets go', async () => {
    const { control, client, socket } = setup();
    await client.connect();
    socket.deliver(OPEN);
    await settle();

    await client.disconnect();

    expect(control?.sent.at(-1)).toEqual({ t: 'realtime_end' });
  });
});
