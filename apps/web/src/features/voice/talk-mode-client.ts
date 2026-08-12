import {
  type BatchVoiceCallDeps,
  createBatchVoiceCallClient,
  type VoiceTuning,
} from './batch-voice-call-client';
import { createBrowserPlayout, createBrowserVoiceCapture } from './browser-streaming-io';
import { createStreamingVoiceCallClient } from './streaming-voice-call-client';
import type { VoiceCallClient } from './voice-call-client';
import { createVoiceSocketTransport, voiceSocketUrl } from './voice-socket-transport';
import { createWakeLock } from './wake-lock';

// Which talk-mode transport a browser gets.
//
// Streaming (binary PCM over one WebSocket, WebAudio playout) is the default.
// The batch path — one transcribe RPC per utterance, one synthesize RPC per
// sentence, `<audio>` playout — stays as the documented fallback for a browser
// that cannot do the streaming pieces. Both drive the same conversation and
// emit the same `VoiceCallEvent`s, so the UI does not know which one it has.

export interface TalkModeEnvironment {
  hasWebSocket: boolean;
  hasAudioContext: boolean;
  hasMediaDevices: boolean;
  hasScriptProcessor: boolean;
}

export function readTalkModeEnvironment(): TalkModeEnvironment {
  const audioContextCtor =
    typeof AudioContext !== 'undefined'
      ? AudioContext
      : (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext;
  return {
    hasWebSocket: typeof WebSocket !== 'undefined',
    hasAudioContext: typeof audioContextCtor !== 'undefined',
    hasMediaDevices:
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function',
    hasScriptProcessor:
      typeof AudioContext !== 'undefined' &&
      typeof AudioContext.prototype.createScriptProcessor === 'function',
  };
}

/** Every streaming piece must be present; one missing sends the call to batch. */
export function streamingTalkModeSupported(env: TalkModeEnvironment): boolean {
  return env.hasWebSocket && env.hasAudioContext && env.hasMediaDevices && env.hasScriptProcessor;
}

export interface TalkModeClientDeps extends BatchVoiceCallDeps {
  /** Chat session the call belongs to; stamped on the lane for telemetry. */
  sessionId?: () => string | null;
  /** Force the batch path (fallback verification, or a broken provider). */
  forceBatch?: boolean;
  /** Overridden in tests; defaults to the current page origin. */
  socketUrl?: string;
  environment?: TalkModeEnvironment;
}

export function createTalkModeClient(deps: TalkModeClientDeps): VoiceCallClient {
  const env = deps.environment ?? readTalkModeEnvironment();
  if (deps.forceBatch || !streamingTalkModeSupported(env)) {
    return createBatchVoiceCallClient(deps);
  }

  const context = new AudioContext();
  const tuning: Partial<VoiceTuning> = deps.tuning ?? {};
  const capture = createBrowserVoiceCapture({
    context,
    tuning,
    onDispose: () => context.close().catch(() => {}),
  });

  return createStreamingVoiceCallClient({
    transport: createVoiceSocketTransport({
      url: deps.socketUrl ?? voiceSocketUrl(window.location),
    }),
    capture,
    playout: createBrowserPlayout(context),
    runAgentTurn: deps.runAgentTurn,
    wakeLock: createWakeLock(),
    ...(deps.sessionId ? { sessionId: deps.sessionId } : {}),
    ...(deps.voice ? { voice: deps.voice } : {}),
    ...(deps.personalityId ? { personalityId: deps.personalityId } : {}),
    ...(deps.chime !== undefined ? { chime: deps.chime } : {}),
  });
}
