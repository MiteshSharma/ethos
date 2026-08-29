import type {
  RealtimeSocket,
  RealtimeSocketFactory,
  RealtimeSocketHandlers,
  RealtimeSocketInit,
} from '@ethosagent/voice-realtime-protocol';
import { pcm16ToBytes } from '@ethosagent/web-contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  createRealtimeVoiceCallClient,
  type RealtimeSessionTicket,
} from '../realtime-voice-call-client';
import type { VoiceCallEvent } from '../voice-call-client';
import { FakePlayout, FakeVoiceCapture } from './streaming-fakes';

// The realtime tier's conversation, driven against an in-memory provider — no
// network, no audio hardware, no timers. The provider's frames go in through
// `deliver()` and what the UI would see comes out as `VoiceCallEvent`s.

/** The provider socket, under the test's control from both ends. */
class FakeProviderSocket {
  readonly sent: unknown[] = [];
  init: RealtimeSocketInit | undefined;
  clientClosed = false;
  /** Every `init` this factory was handed, in order — one per dial. */
  readonly dials: RealtimeSocketInit[] = [];
  /** True → the next socket closes before it opens, as a still-dead network does. */
  refuse = false;
  private handlers: RealtimeSocketHandlers | undefined;

  readonly factory: RealtimeSocketFactory = (init, handlers): RealtimeSocket => {
    this.init = init;
    this.dials.push(init);
    this.handlers = handlers;
    const refused = this.refuse;
    queueMicrotask(() => (refused ? handlers.onClose('still down') : handlers.onOpen()));
    return {
      send: (data: string) => {
        this.sent.push(JSON.parse(data));
      },
      close: () => {
        this.clientClosed = true;
      },
    };
  };

  deliver(frame: unknown): void {
    this.handlers?.onMessage(JSON.stringify(frame));
  }

  drop(reason: string): void {
    this.handlers?.onClose(reason);
  }
}

/** Timer seam for the reconnect backoff: nothing fires until the test says so. */
class FakeSchedule {
  readonly delays: number[] = [];
  private next = 1;
  private readonly tasks = new Map<number, () => void>();

  readonly schedule = (fn: () => void, ms: number): unknown => {
    this.delays.push(ms);
    const handle = this.next;
    this.next += 1;
    this.tasks.set(handle, fn);
    return handle;
  };

  readonly cancel = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };

  /** Fire everything queued, in the order it was queued. */
  run(): void {
    const due = [...this.tasks.values()];
    this.tasks.clear();
    for (const fn of due) fn();
  }

  get pending(): number {
    return this.tasks.size;
  }
}

const TICKET: RealtimeSessionTicket = {
  providerId: 'openai-realtime',
  model: 'gpt-realtime',
  token: 'ek_test',
  expiresAt: Date.now() + 60_000,
  url: 'wss://api.openai.com/v1/realtime?model=gpt-realtime',
  inputSampleRate: 16_000,
  outputSampleRate: 24_000,
};

function setup(
  ticket: RealtimeSessionTicket = TICKET,
  opts: {
    reconnectDelaysMs?: number[];
    mintTicket?: () => Promise<RealtimeSessionTicket | null>;
  } = {},
) {
  const socket = new FakeProviderSocket();
  // `FakeVoiceCapture.sampleRate` is 16 kHz, matching the ticket's input rate:
  // the client refuses to run when they disagree rather than resampling.
  const capture = new FakeVoiceCapture();
  const playout = new FakePlayout();
  const clock = new FakeSchedule();
  const events: VoiceCallEvent[] = [];
  const client = createRealtimeVoiceCallClient({
    session: ticket,
    capture,
    playout,
    socketFactory: socket.factory,
    chime: false,
    schedule: clock.schedule,
    cancelSchedule: clock.cancel,
    ...(opts.reconnectDelaysMs ? { reconnectDelaysMs: opts.reconnectDelaysMs } : {}),
    ...(opts.mintTicket ? { mintTicket: opts.mintTicket } : {}),
  });
  client.on((event) => events.push(event));
  return { socket, capture, playout, clock, events, client };
}

/** One macrotask boundary drains whatever the socket callbacks queued. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const OPEN = { type: 'session.created', session: { id: 'sess_1', model: 'gpt-realtime' } };

function audioFrame(bytes: number[]): unknown {
  return {
    type: 'response.output_audio.delta',
    delta: btoa(String.fromCharCode(...bytes)),
  };
}

describe('realtime voice call client — connection', () => {
  it('opens the provider socket at the minted url, carrying the token in a subprotocol', async () => {
    const { socket, client } = setup();
    await client.connect();

    expect(socket.init?.url).toBe(TICKET.url);
    // A browser WebSocket cannot set an Authorization header, so the ephemeral
    // credential rides here. It must never appear as a header.
    expect(socket.init?.headers).toBeUndefined();
    expect(socket.init?.subprotocols).toContain('openai-insecure-api-key.ek_test');
    await client.disconnect();
  });

  it('writes no handshake — the session config was baked into the token', async () => {
    const { socket, client } = setup();
    await client.connect();
    expect(socket.sent).toEqual([]);
    await client.disconnect();
  });

  it('reports the link as open when the provider confirms the session', async () => {
    const { socket, events, client } = setup();
    await client.connect();
    socket.deliver(OPEN);
    await settle();
    expect(events).toContainEqual({ type: 'link', status: 'open' });
    await client.disconnect();
  });

  it('refuses to run when the browser cannot capture at the provider’s input rate', async () => {
    // Refusing beats resampling: a resampler on the capture hot path is exactly
    // what splitting inputSampleRate from outputSampleRate removed.
    const { client, capture } = setup({ ...TICKET, inputSampleRate: 24_000 });
    await expect(client.connect()).rejects.toThrow(/24000 Hz/);
    expect(capture.stopped).toBe(true);
  });
});

describe('realtime voice call client — conversation', () => {
  it('commits only the SETTLED user transcript as a turn', async () => {
    const { socket, events, client } = setup();
    await client.connect();
    socket.deliver(OPEN);
    socket.deliver({
      type: 'conversation.item.input_audio_transcription.delta',
      delta: 'what is ',
    });
    await settle();
    expect(events.filter((e) => e.type === 'utterance_committed')).toEqual([]);

    socket.deliver({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'what is the weather',
    });
    await settle();
    expect(events).toContainEqual({
      type: 'utterance_committed',
      text: 'what is the weather',
      provider: 'openai-realtime',
    });
    await client.disconnect();
  });

  it('streams the reply as sentences and completes with the full text', async () => {
    const { socket, events, client } = setup();
    await client.connect();
    socket.deliver(OPEN);
    socket.deliver({ type: 'response.output_audio_transcript.delta', delta: 'Clear skies. ' });
    socket.deliver({ type: 'response.output_audio_transcript.delta', delta: 'Twelve degrees.' });
    await settle();
    expect(
      events.filter((e) => e.type === 'reply_sentence').map((e) => (e as { text: string }).text),
    ).toEqual(['Clear skies.']);

    socket.deliver({ type: 'response.done' });
    await settle();
    expect(events.at(-1)).toEqual({
      type: 'reply_complete',
      text: 'Clear skies. Twelve degrees.',
    });
    await client.disconnect();
  });

  it('plays reply audio at the provider’s OUTPUT rate and names the provider once', async () => {
    const { socket, playout, events, client } = setup();
    await client.connect();
    socket.deliver(OPEN);
    socket.deliver(audioFrame([1, 0, 2, 0]));
    socket.deliver(audioFrame([3, 0, 4, 0]));
    await settle();

    expect(playout.pcm).toEqual([
      { samples: 2, sampleRate: 24_000 },
      { samples: 2, sampleRate: 24_000 },
    ]);
    // Announced per response, not per frame: audio arrives far faster than any
    // UI needs to re-render.
    expect(events.filter((e) => e.type === 'reply_audio')).toEqual([
      { type: 'reply_audio', audio: new Uint8Array(0), format: 'pcm', provider: 'openai-realtime' },
    ]);
    await client.disconnect();
  });

  it('streams captured mic frames to the provider continuously', async () => {
    const { socket, capture, client } = setup();
    await client.connect();
    socket.deliver(OPEN);
    await settle();

    const pcm = Int16Array.from([1000, -1000, 500]);
    capture.emit({ type: 'frame', data: pcm });
    await settle();

    const audio = socket.sent.filter(
      (frame): frame is { type: string; audio: string } =>
        typeof frame === 'object' && frame !== null && 'type' in frame,
    );
    expect(audio).toHaveLength(1);
    expect(audio[0]?.type).toBe('input_audio_buffer.append');
    // Verbatim: the browser captures at the provider's input rate, so nothing
    // is converted on the way out.
    expect(audio[0]?.audio).toBe(btoa(String.fromCharCode(...pcm16ToBytes(pcm))));
    await client.disconnect();
  });
});

describe('realtime voice call client — barge-in', () => {
  it('stops playout, cancels the model, and keeps the spoken prefix as interrupted', async () => {
    const { socket, playout, events, client } = setup();
    await client.connect();
    socket.deliver(OPEN);
    socket.deliver({ type: 'response.output_audio_transcript.delta', delta: 'Sentence one. ' });
    socket.deliver(audioFrame([1, 0]));
    await settle();

    const stopsBefore = playout.stops;
    const sentBefore = socket.sent.length;
    socket.deliver({ type: 'input_audio_buffer.speech_started' });
    await settle();

    // Playback stops rather than being left to run out...
    expect(playout.stops).toBe(stopsBefore + 1);
    // ...and the model is told to stop generating.
    expect(socket.sent.slice(sentBefore)).toEqual([{ type: 'response.cancel' }]);
    // The honestly-spoken prefix is what the transcript keeps.
    expect(events.at(-1)).toEqual({ type: 'interrupted', text: 'Sentence one.' });
    await client.disconnect();
  });

  it('ignores a speech signal when the model does not have the floor', async () => {
    const { socket, playout, events, client } = setup();
    await client.connect();
    socket.deliver(OPEN);
    await settle();
    const stopsBefore = playout.stops;

    socket.deliver({ type: 'input_audio_buffer.speech_started' });
    await settle();

    expect(playout.stops).toBe(stopsBefore);
    expect(events.some((e) => e.type === 'interrupted')).toBe(false);
    await client.disconnect();
  });
});

describe('realtime voice call client — failure and teardown', () => {
  it('surfaces a recoverable provider error without ending the call', async () => {
    const { socket, events, client } = setup();
    await client.connect();
    socket.deliver(OPEN);
    socket.deliver({
      type: 'error',
      error: { message: 'rate limited', code: 'rate_limit_exceeded' },
    });
    await settle();

    expect(events).toContainEqual({
      type: 'error',
      error: 'rate limited',
      code: 'rate_limit_exceeded',
      provider: 'openai-realtime',
    });
    expect(events.some((e) => e.type === 'disconnected')).toBe(false);
    await client.disconnect();
  });

  it('releases the mic, the socket and the playout on disconnect', async () => {
    const { socket, capture, playout, client } = setup();
    await client.connect();
    socket.deliver(OPEN);
    await settle();

    await client.disconnect();
    expect(capture.stopped).toBe(true);
    expect(socket.clientClosed).toBe(true);
    expect(playout.stops).toBeGreaterThan(0);
  });

  it('mutes the microphone without tearing down the session', async () => {
    const { socket, capture, client } = setup();
    await client.connect();
    socket.deliver(OPEN);
    client.setMuted(true);
    expect(capture.micEnabled).toBe(false);
    client.setMuted(false);
    expect(capture.micEnabled).toBe(true);
    await client.disconnect();
  });

  it('never opens a socket of its own — the transport is fully injected', async () => {
    // The guarantee that makes this whole client testable: no `new WebSocket`
    // anywhere inside it.
    const globalSocket = vi.fn();
    const original = globalThis.WebSocket;
    Object.defineProperty(globalThis, 'WebSocket', {
      value: globalSocket,
      configurable: true,
      writable: true,
    });
    try {
      const { client, socket } = setup();
      await client.connect();
      socket.deliver(OPEN);
      await settle();
      await client.disconnect();
      expect(globalSocket).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, 'WebSocket', {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });
});

describe('realtime voice call client — provider link drop (DR1 "Reconnecting")', () => {
  it('reconnects on the app lane’s backoff instead of ending the call', async () => {
    const { socket, events, clock, client } = setup();
    await client.connect();
    socket.deliver(OPEN);
    await settle();

    socket.drop('network went away');
    await settle();

    // The strip goes amber, not dead — the composer stays usable meanwhile.
    expect(events.at(-1)).toEqual({ type: 'link', status: 'reconnecting' });
    expect(events.some((e) => e.type === 'disconnected')).toBe(false);
    // The same first delay the app's voice socket uses: one policy, not two.
    expect(clock.delays).toEqual([250]);

    clock.run();
    await settle();
    socket.deliver(OPEN);
    await settle();

    // A second dial actually happened, and the link is live again.
    expect(socket.dials).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: 'link', status: 'open' });
    await client.disconnect();
  });

  it('discards the in-flight turn and keeps the honestly-spoken prefix', async () => {
    // A9's rule, unchanged: the in-flight utterance is discarded and the call
    // comes back to a fresh listen. What was already SAID is not discarded.
    const { socket, playout, events, client } = setup();
    await client.connect();
    socket.deliver(OPEN);
    socket.deliver({ type: 'response.output_audio_transcript.delta', delta: 'Sentence one. ' });
    await settle();
    const stopsBefore = playout.stops;

    socket.drop('network went away');
    await settle();

    expect(playout.stops).toBe(stopsBefore + 1);
    expect(events).toContainEqual({ type: 'interrupted', text: 'Sentence one.' });
    await client.disconnect();
  });

  it('re-mints an expired credential rather than redialling with a dead one', async () => {
    const expired = { ...TICKET, expiresAt: Date.now() - 1 };
    const fresh = { ...TICKET, token: 'ek_fresh', expiresAt: Date.now() + 60_000 };
    const { socket, clock, client } = setup(expired, { mintTicket: () => Promise.resolve(fresh) });
    await client.connect();
    socket.deliver(OPEN);
    await settle();

    socket.drop('network went away');
    await settle();
    clock.run();
    await settle();

    // The redial carries the NEW secret; the expired one is never re-offered.
    expect(socket.dials[1]?.subprotocols).toContain('openai-insecure-api-key.ek_fresh');
    await client.disconnect();
  });

  it('gives up and degrades to text when the credential is dead and nothing can mint', async () => {
    const expired = { ...TICKET, expiresAt: Date.now() - 1 };
    const { socket, events, clock, client } = setup(expired);
    await client.connect();
    socket.deliver(OPEN);
    await settle();

    socket.drop('network went away');
    await settle();
    clock.run();
    await settle();

    // No second dial was attempted on a secret that cannot work.
    expect(socket.dials).toHaveLength(1);
    expect(events.some((e) => e.type === 'error' && e.code === 'voice_unavailable')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'disconnected' });
  });

  it('stops after the schedule is spent rather than retrying forever', async () => {
    const { socket, events, clock, client } = setup(TICKET, { reconnectDelaysMs: [1, 2] });
    await client.connect();
    socket.deliver(OPEN);
    await settle();

    // The network is still down for every attempt.
    socket.refuse = true;
    socket.drop('network went away');
    await settle();
    clock.run();
    await settle();
    clock.run();
    await settle();

    expect(clock.delays).toEqual([1, 2]);
    expect(clock.pending).toBe(0);
    // Three dials total: the original plus the schedule's two attempts.
    expect(socket.dials).toHaveLength(3);
    expect(events.some((e) => e.type === 'error' && e.code === 'voice_unavailable')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'disconnected' });
  });

  it('does not redial a call the user hung up', async () => {
    const { socket, clock, client } = setup();
    await client.connect();
    socket.deliver(OPEN);
    await settle();

    await client.disconnect();
    socket.drop('closed');
    await settle();

    expect(clock.pending).toBe(0);
    expect(socket.dials).toHaveLength(1);
  });
});
