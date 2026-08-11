// The one transcript hallucination filter (voice V1a, eng-review D8).
//
// STT engines invent boilerplate on silence or noise: YouTube outros, bracketed
// sound cues, a lone "you". Every surface that turns audio into a turn drops
// those before they reach the agent. Previously reimplemented in the gateway,
// voice-session, and web-api; this is the union of all three lists.

const HALLUCINATION_PATTERNS = [
  /^thanks?\s*(you\s*)?(for\s+)?(watching|listening|viewing)/i,
  /^please\s+(like\s+and\s+)?subscribe/i,
  /^(sub(scribe)?|like)\s+(to\s+)?(the\s+)?channel/i,
  /^\s*$/,
  /^\.+$/,
  /^you$/i,
  /^(music|applause|laughter)\s*$/i,
  /^\[.*\]\s*$/,
];

// The other classic artifact: one short phrase looped back to back
// ("thank you. thank you. thank you."), which the pattern list above cannot
// express. Requires three total occurrences so genuine emphasis ("no, no")
// still gets through.
const REPETITIVE_ARTIFACT = /^(.{1,40}?)[\s.,!?-]*(?:\1[\s.,!?-]*){2,}$/i;

// The backreference above backtracks; bound the input it runs on so a long
// legitimate transcript can never become a pathological match.
const REPETITION_SCAN_MAX_CHARS = 300;

/** True when the transcript is empty or a known STT phantom, and must be dropped. */
export function isHallucination(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (HALLUCINATION_PATTERNS.some((p) => p.test(trimmed))) return true;
  return trimmed.length <= REPETITION_SCAN_MAX_CHARS && REPETITIVE_ARTIFACT.test(trimmed);
}
