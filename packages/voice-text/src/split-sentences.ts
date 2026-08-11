// The one sentence splitter (voice V1a, eng-review D8).
//
// Speech is synthesized a sentence at a time so playout can start before the
// model finishes. The splitter therefore has to be honest about incompleteness:
// it returns the sentences it is SURE about plus the trailing remainder, which
// the caller keeps for the next chunk (or speaks at end of turn).
//
// Unicode-aware: Latin `.!?` need trailing whitespace to confirm a boundary
// (so "3.14" and a mid-stream "Dr." do not split), while CJK `。！？` are
// boundaries on their own — CJK text carries no inter-sentence spaces.

/** Latin sentence terminators. A run of these needs trailing whitespace. */
const LATIN_TERMINATORS = '.!?';
/** Full-width terminators. Self-sufficient — CJK does not space its sentences. */
const CJK_TERMINATORS = '。！？';
/** Closing punctuation that belongs to the sentence it follows. */
const CLOSERS = '"\')]}»”’」』】〉';

/**
 * Whitespace index at or after this many characters becomes a boundary when no
 * terminator has appeared. Long unpunctuated replies would otherwise buffer to
 * the end of the turn and stall playout.
 */
export const DEFAULT_SOFT_BREAK_CHARS = 72;

export interface SplitSentencesOptions {
  /** Soft-break threshold in characters. `0` disables soft breaking. */
  softBreakChars?: number;
}

export interface SentenceSplit {
  /** Sentences that are definitely complete, in order. */
  sentences: string[];
  /** Trailing text whose completeness is not yet known. */
  rest: string;
}

const isTerminator = (ch: string): boolean =>
  LATIN_TERMINATORS.includes(ch) || CJK_TERMINATORS.includes(ch);

// Abbreviations whose trailing period is not a sentence end. Deliberately
// short: an unlisted abbreviation over-splits, which for speech is a pause in
// the wrong place, not a broken turn.
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'no',
  'inc',
  'ltd',
  'co',
  'approx',
  'fig',
  'al',
]);

// Dotted initialisms — "e.g.", "i.e.", "U.S.". By the time the boundary scan
// reaches the final period, the text before it already ends in `<letter>.<letter>`.
const DOTTED_INITIALISM = /(?:^|[^A-Za-z])(?:[A-Za-z]\.)+[A-Za-z]$/;

function endsWithAbbreviation(before: string): boolean {
  if (DOTTED_INITIALISM.test(before)) return true;
  const match = /([A-Za-z]+)$/.exec(before);
  const word = match?.[1];
  if (!word) return false;
  return ABBREVIATIONS.has(word.toLowerCase());
}

interface Boundary {
  /** Index just past the sentence text. */
  end: number;
  /** Index where the next sentence starts (trailing whitespace consumed). */
  nextStart: number;
}

function findBoundary(text: string): Boundary | null {
  for (let i = 0; i < text.length; i++) {
    if (!isTerminator(text[i] ?? '')) continue;

    let run = i;
    while (run < text.length && isTerminator(text[run] ?? '')) run++;
    const terminators = text.slice(i, run);
    const hasCjkTerminator = [...terminators].some((ch) => CJK_TERMINATORS.includes(ch));
    // Only a period can be an abbreviation's; "No?" is a question, not "No. 5".
    const periodOnly = /^\.+$/.test(terminators);

    // Closing quotes / brackets ride along with the sentence they close.
    let end = run;
    while (end < text.length && CLOSERS.includes(text[end] ?? '')) end++;

    let nextStart = end;
    while (nextStart < text.length && /\s/.test(text[nextStart] ?? '')) nextStart++;

    // Latin terminators are only a boundary once whitespace confirms it; while
    // streaming, a terminator at end-of-text may still be "3." or "Dr.".
    const confirmed = hasCjkTerminator || nextStart > end;
    const abbreviated = periodOnly && endsWithAbbreviation(text.slice(0, i));
    if (confirmed && !abbreviated) {
      return { end, nextStart };
    }
    i = run - 1;
  }
  return null;
}

function findSoftBreak(text: string, threshold: number): Boundary | null {
  if (threshold <= 0 || text.length <= threshold) return null;
  for (let i = threshold; i < text.length; i++) {
    if (!/\s/.test(text[i] ?? '')) continue;
    let nextStart = i;
    while (nextStart < text.length && /\s/.test(text[nextStart] ?? '')) nextStart++;
    return { end: i, nextStart };
  }
  return null;
}

/**
 * Split `text` into complete sentences plus the trailing remainder.
 *
 * Feed it a growing buffer while streaming: speak `sentences`, keep `rest` for
 * the next call. At end of turn, whatever is left in `rest` is the final
 * sentence.
 */
export function splitSentences(text: string, options: SplitSentencesOptions = {}): SentenceSplit {
  const softBreakChars = options.softBreakChars ?? DEFAULT_SOFT_BREAK_CHARS;
  const sentences: string[] = [];
  let rest = text;

  while (rest.length > 0) {
    // Whichever comes first. A terminator past the soft-break threshold means
    // no terminator appeared before it — exactly when the soft break wins.
    const candidates = [findBoundary(rest), findSoftBreak(rest, softBreakChars)].filter(
      (b): b is Boundary => b !== null,
    );
    if (candidates.length === 0) break;
    const boundary = candidates.reduce((first, next) => (next.end < first.end ? next : first));
    const sentence = rest.slice(0, boundary.end).trim();
    if (sentence.length > 0) sentences.push(sentence);
    rest = rest.slice(boundary.nextStart);
  }

  return { sentences, rest };
}
