// @ethosagent/voice-text — the one speakable-text implementation.
//
// No external runtime dependencies and no I/O: pure text in, pure text out. The
// one contracts import is `VoiceMode`, re-exported from `@ethosagent/types` so
// core can persist the mode without depending on this package.
// Every surface that turns audio into a turn or a turn into audio (gateway,
// voice-session, web-api, the browser talk path) imports from here. A second
// copy of any of these functions is a bug — `drift-gate.test.ts` fails on it.

export { type DetectLanguageOptions, detectLanguage } from './detect-language';
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
export {
  boundedLevenshtein,
  DEFAULT_WAKE_SENSITIVITY,
  matchWakePhrase,
  normalizeUtterance,
  stripWakePhrase,
  type WakePhrase,
  type WakePhraseMatch,
  wakePhraseKey,
} from './wake-match';
