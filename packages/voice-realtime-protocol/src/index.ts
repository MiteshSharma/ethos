// @ethosagent/voice-realtime-protocol — the realtime speech-to-speech wire
// mapping, shared by the server-side providers and the browser-direct client.
//
// The rule this package exists to keep: NOTHING here may import `ws` or a
// `node:` builtin, because `apps/web` bundles it to talk to OpenAI Realtime
// straight from the page. `src/__tests__/browser-safety.test.ts` fails the
// build if that ever stops being true.

export { base64ToPcm, pcmToBase64 } from './base64';
export type {
  RealtimeDecodeResult,
  RealtimeProtocolCodec,
  RealtimeProtocolHandshake,
} from './codec';
export {
  createGeminiLiveCodec,
  GEMINI_LIVE_INPUT_SAMPLE_RATE,
  GEMINI_LIVE_OUTPUT_SAMPLE_RATE,
} from './gemini';
export {
  createOpenAiRealtimeCodec,
  OPENAI_REALTIME_INPUT_SAMPLE_RATE,
  OPENAI_REALTIME_OUTPUT_SAMPLE_RATE,
  openaiRealtimeBrowserSubprotocols,
} from './openai';
export {
  createRealtimeProtocolSession,
  type RealtimeProtocolSessionOptions,
  type UnconnectedRealtimeSession,
} from './session';
export { MAX_PENDING_AUDIO_FRAMES, RealtimeSessionCore } from './session-core';
export type {
  RealtimeSocket,
  RealtimeSocketFactory,
  RealtimeSocketHandlers,
  RealtimeSocketInit,
} from './socket';
