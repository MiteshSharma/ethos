// @ethosagent/voice-text — the one speakable-text implementation.
//
// Zero runtime dependencies, no I/O, no contracts: pure text in, pure text out.
// Every surface that turns audio into a turn or a turn into audio (gateway,
// voice-session, web-api, the browser talk path) imports from here. A second
// copy of any of these functions is a bug — `drift-gate.test.ts` fails on it.

export { isHallucination } from './hallucination';
export { sanitizeForSpeech } from './sanitize';
export { SentenceChunker } from './sentence-chunker';
export {
  DEFAULT_SOFT_BREAK_CHARS,
  type SentenceSplit,
  type SplitSentencesOptions,
  splitSentences,
} from './split-sentences';
export { truncateAtSentenceBoundary } from './truncate';
export {
  DEFAULT_VOICE_MODE,
  shouldReplyWithVoice,
  type VoiceMode,
  type VoiceReplyDecisionInput,
} from './voice-mode';
