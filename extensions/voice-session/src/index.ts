// @ethosagent/voice-session — streaming voice orchestration over AgentLoop.
//
// Speakable-text helpers (`isHallucination`, `SentenceChunker`, …) are not
// re-exported here: they live in @ethosagent/voice-text, which every voice
// surface imports directly.

export { createBufferedSttAdapter } from './buffered-stt';
export { EndpointDetector, type EndpointDetectorConfig } from './endpoint-detector';
export {
  percentile,
  type StagePercentiles,
  summarizeLatency,
  turnLatenciesFromSpans,
  VOICE_LATENCY_BUDGET_MS,
  VOICE_LATENCY_STAGES,
  type VoiceLatencyReport,
  type VoiceLatencyStage,
  type VoiceTurnLatency,
} from './latency-budget';
export {
  type PlayoutItem,
  PlayoutQueue,
  type PlayoutQueueCallbacks,
} from './playout-queue';
export {
  BufferedVoiceSpanWriter,
  type BufferedVoiceSpanWriterOptions,
  type VoiceSpanSink,
  type VoiceSpanStage,
  type VoiceTurnSpan,
} from './span-writer';
export type {
  AgentTurnRunner,
  AudioFormat,
  Vad,
  VoiceSessionConfig,
  VoiceSessionEvent,
  VoiceSessionState,
} from './types';
export { DEFAULT_VOICE_FILLER_TEXT } from './types';
export { EnergyVad, type EnergyVadConfig, rmsEnergy } from './vad';
export { VoiceSession, type VoiceSessionDeps } from './voice-session';
export { encodeWav } from './wav';
