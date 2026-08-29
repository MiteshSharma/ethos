// Hard cap for a TTS provider's `caps.maxInputChars`. Cutting mid-word is
// audible, so back off to the last sentence end and only fall back to a word
// boundary when that would throw away more than half the budget.

const TERMINATORS = ['.', '!', '?', '。', '！', '？'];

/** Trim `text` to at most `maxChars`, preferring a sentence then a word boundary. */
export function truncateAtSentenceBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  const lastSentenceEnd = Math.max(...TERMINATORS.map((t) => truncated.lastIndexOf(t)));
  if (lastSentenceEnd > maxChars * 0.5) {
    return truncated.slice(0, lastSentenceEnd + 1);
  }
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
}
