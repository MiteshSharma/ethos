// A credential-free realtime provider for tests and local dev.
//
// The SIBLING of `createFakeRealtimeServer` in `./realtime-conformance`, one
// layer up: that one fakes a provider's WEBSOCKET so a real provider can be
// driven without a network, this one fakes the PROVIDER so a caller — the
// browser client, the control lane, the latency bench — can be driven without
// a provider at all.
//
// It is deliberately the only such fake in the repo. It grew out of the latency
// bench's mock (`scripts/voice-latency-bench.ts`), which needed exactly the
// realistic bits: a server-side VAD that commits on silence, a settled user
// transcript as the commit marker, and the option to WITHHOLD that marker the
// way a provider that transcribes asynchronously does. Everything else here is
// the rest of one turn — assistant transcript, output audio, a tool call that
// pauses the turn until it is answered — so a second fake never has to exist.

import type {
  RealtimeEvent,
  RealtimeSession,
  RealtimeSessionOptions,
  RealtimeVoiceProvider,
} from '@ethosagent/types';
import { REALTIME_CONTRACT_VERSION } from '@ethosagent/types';

/** What the fake model answers with on every committed turn. */
export interface FakeRealtimeReply {
  /** Settled USER transcript — the frame that marks the commit. */
  userTranscript?: string;
  /** Settled ASSISTANT transcript, delivered with the speech. */
  transcript?: string;
  /** Output speech: PCM16 mono at `caps.outputSampleRate`. */
  pcm?: Uint8Array;
  /**
   * A tool the model calls before it answers. The turn PAUSES on the call and
   * resumes when {@link RealtimeSession.sendToolResult} answers it — the
   * duplex ordering a caller has to get right, rather than a fire-and-forget
   * event it can ignore.
   */
  toolCall?: { name: string; args: Record<string, unknown> };
}

export interface FakeRealtimeOptions {
  /** Silence after the last `sendAudio` before the VAD commits the turn. */
  commitMs?: number;
  /** Delay from the commit to the first output audio frame. */
  audioMs?: number;
  /**
   * Emit the settled user transcript on commit. `false` is the provider that
   * transcribes asynchronously: the turn commits with no marker at all.
   */
  emitCommitMarker?: boolean;
  reply?: FakeRealtimeReply;
  inputSampleRate?: number;
  outputSampleRate?: number;
}

/** A live fake session, plus everything the caller wrote into it. */
export interface FakeRealtimeSession extends RealtimeSession {
  /** Every `sendAudio` payload, in order — the caller's half of the duplex. */
  readonly audioIn: readonly Uint8Array[];
  readonly toolResults: ReadonlyArray<{ callId: string; output: string }>;
  readonly interrupts: number;
  /** Push any event to the consumer — barge-in, errors, provider oddities. */
  emit(event: RealtimeEvent): void;
}

export interface FakeRealtimeProvider extends RealtimeVoiceProvider {
  open(opts: RealtimeSessionOptions): Promise<FakeRealtimeSession>;
  /** Options each `open()` was called with, in order. */
  readonly opened: readonly RealtimeSessionOptions[];
}

const DEFAULT_REPLY: Required<Omit<FakeRealtimeReply, 'toolCall'>> = {
  userTranscript: 'what is the weather',
  transcript: 'it is sunny',
  // Two bytes: one PCM16 sample. Enough to be an audio frame, small enough that
  // nothing is tempted to treat it as real speech.
  pcm: new Uint8Array([0, 0]),
};

/**
 * A realtime provider that needs no credentials, no network and no timers
 * beyond the two delays it is configured with.
 */
export function createFakeRealtimeProvider(opts: FakeRealtimeOptions = {}): FakeRealtimeProvider {
  const commitMs = opts.commitMs ?? 0;
  const audioMs = opts.audioMs ?? 0;
  const emitCommitMarker = opts.emitCommitMarker ?? true;
  const reply = { ...DEFAULT_REPLY, ...opts.reply };
  const outputSampleRate = opts.outputSampleRate ?? 24_000;
  const opened: RealtimeSessionOptions[] = [];

  return {
    name: 'fake-realtime',
    caps: {
      kind: 'realtime',
      inputSampleRate: opts.inputSampleRate ?? 16_000,
      outputSampleRate,
      // Nothing leaves the process — this is the one provider that can honestly
      // say so, which is also what keeps it outside the local-only egress gate.
      local: true,
      contractVersion: REALTIME_CONTRACT_VERSION,
    },
    opened,
    open(sessionOptions: RealtimeSessionOptions): Promise<FakeRealtimeSession> {
      opened.push(sessionOptions);
      return Promise.resolve(
        openFakeSession({ commitMs, audioMs, emitCommitMarker, reply, outputSampleRate }),
      );
    },
  };
}

interface FakeSessionConfig {
  commitMs: number;
  audioMs: number;
  emitCommitMarker: boolean;
  outputSampleRate: number;
  reply: Required<Omit<FakeRealtimeReply, 'toolCall'>> & {
    toolCall?: FakeRealtimeReply['toolCall'];
  };
}

function openFakeSession(config: FakeSessionConfig): FakeRealtimeSession {
  const queue: RealtimeEvent[] = [];
  const audioIn: Uint8Array[] = [];
  const toolResults: Array<{ callId: string; output: string }> = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let interrupts = 0;
  let turns = 0;
  let commitTimer: ReturnType<typeof setTimeout> | null = null;
  let replyTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingCallId: string | null = null;

  const push = (event: RealtimeEvent): void => {
    if (closed) return;
    queue.push(event);
    const waiter = wake;
    wake = null;
    waiter?.();
  };

  /** The spoken half of a turn: transcript, speech, done. */
  const speak = (): void => {
    if (config.reply.transcript) {
      push({ type: 'transcript', role: 'assistant', text: config.reply.transcript, isFinal: true });
    }
    if (config.reply.pcm.length > 0) {
      push({ type: 'audio', pcm: config.reply.pcm, sampleRate: config.outputSampleRate });
    }
    push({ type: 'response_done', responseId: `resp-${turns}` });
  };

  const respond = (): void => {
    const tool = config.reply.toolCall;
    if (tool) {
      // The turn stops here until `sendToolResult` answers — a caller that
      // never answers gets silence, exactly as it would from a real provider.
      pendingCallId = `call-${turns}`;
      push({ type: 'tool_call', callId: pendingCallId, name: tool.name, args: tool.args });
      return;
    }
    speak();
  };

  const commit = (): void => {
    turns += 1;
    if (config.emitCommitMarker) {
      push({ type: 'transcript', role: 'user', text: config.reply.userTranscript, isFinal: true });
    }
    replyTimer = setTimeout(respond, config.audioMs);
  };

  const events: AsyncIterable<RealtimeEvent> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = queue.shift();
        if (next) {
          yield next;
          if (next.type === 'closed') return;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };

  push({ type: 'session_open', sessionId: 'fake', model: 'fake-realtime-1' });

  return {
    events,
    get audioIn() {
      return audioIn;
    },
    get toolResults() {
      return toolResults;
    },
    get interrupts() {
      return interrupts;
    },
    emit: push,
    sendAudio: (pcm: Uint8Array): Promise<void> => {
      audioIn.push(pcm);
      // Every frame restarts the silence window — this is the provider's VAD.
      if (commitTimer) clearTimeout(commitTimer);
      commitTimer = setTimeout(commit, config.commitMs);
      return Promise.resolve();
    },
    sendToolResult: (callId: string, output: string): Promise<void> => {
      toolResults.push({ callId, output });
      if (callId === pendingCallId) {
        pendingCallId = null;
        speak();
      }
      return Promise.resolve();
    },
    interrupt: (): Promise<void> => {
      interrupts += 1;
      // Barge-in kills the in-flight response rather than letting it land late
      // over the top of the user — the behaviour the surface is tested against.
      if (replyTimer) clearTimeout(replyTimer);
      replyTimer = null;
      return Promise.resolve();
    },
    close: (): Promise<void> => {
      if (commitTimer) clearTimeout(commitTimer);
      if (replyTimer) clearTimeout(replyTimer);
      commitTimer = null;
      replyTimer = null;
      push({ type: 'closed', reason: 'closed by caller' });
      closed = true;
      // Wake a consumer parked on an empty queue so the iterable can finish.
      const waiter = wake;
      wake = null;
      waiter?.();
      return Promise.resolve();
    },
  };
}
