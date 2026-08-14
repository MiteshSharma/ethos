// Wake-phrase matching against a recognized transcript.
//
// WHY IT LIVES HERE and not in `extensions/voice-satellite`, where it was born.
// Three surfaces need the same answer to "does this sentence wake something?":
// the satellite's transcript engine, which is the one that actually opens a
// turn; the acoustic engine, which normalizes the same phrases before handing
// them to a keyword spotter; and Settings → Voice's live phrase tester, which
// exists to prove a route BEFORE it is saved. The browser is a first-class
// caller there, and an app may not import a concrete extension
// (ARCHITECTURE.md §III Law 5) — nor could it, since that package's barrel
// reaches for `ws` and native audio bindings.
//
// A second copy of this matcher would be worse than no tester: the tester would
// slowly start disagreeing with the microphone about which phrase wakes which
// personality, and the disagreement would only show up in a room. So it moved
// down to the package whose whole premise is one implementation — `drift-gate.
// test.ts` now fails on a second declaration of any name below.
//
// Pure text in, pure decision out. No audio, no I/O, no dependencies.

/** Default when the caller passes none. Yields ~1 edit per 8-char word. */
export const DEFAULT_WAKE_SENSITIVITY = 0.5;

/**
 * Edits allowed in a word, as a fraction of its length, at sensitivity 1.0.
 * A word tolerates a slip roughly every four characters at full sensitivity and
 * every eight at the default — so "hey" is always exact and "engineer" absorbs
 * one substitution.
 */
const EDITS_PER_CHAR = 0.25;

/** Hard cap. Past two edits a "near match" is a different word, not a slip. */
const MAX_WORD_EDITS = 2;

/** One candidate phrase, identified by whatever key the caller routes on. */
export interface WakePhrase {
  id: string;
  phrase: string;
}

export interface WakePhraseMatch {
  id: string;
  /** The phrase as the caller supplied it — not the normalized form. */
  phrase: string;
  /** 0..1, relative to the matched phrase's own length. Not cross-engine. */
  confidence: number;
  /**
   * How many words of the utterance were the ADDRESS — the greeting the speaker
   * may have put in front, plus the phrase itself. `stripWakePhrase` cuts here.
   * Carried on the match rather than recomputed because only the matcher knows
   * which alignment won (see `matchWakePhrase`).
   */
  wordsConsumed: number;
}

/**
 * Lowercase, drop punctuation, collapse whitespace. Unicode-aware: a phrase in
 * a non-Latin script must survive normalization, and `\w` would not.
 */
export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Greetings that may sit in front of an address, longest first.
 *
 * WHY THIS EXISTS. The trigger is the NAME. "hey" was the fragile half of
 * "hey researcher": speech-to-text renders it as "hay", as "a", as "eh", or
 * drops it outright, and a wake surface that requires a word nobody pronounces
 * carefully is a wake surface that misses. So the greeting became optional on
 * both sides — see `matchWakePhrase` for the symmetry that makes it one rule
 * rather than a matrix of cases.
 *
 * Matched EXACTLY, with no edit tolerance. A greeting is the part we decided
 * not to depend on; forgiving it fuzzily would buy back the unreliability at
 * the cost of letting arbitrary short leading words open the door.
 */
const LEADING_FILLERS: readonly (readonly string[])[] = [
  ['hey', 'there'],
  ['hey'],
  ['hi'],
  ['hello'],
  ['ok'],
  ['okay'],
  ['yo'],
];

/**
 * A normalized string with one leading greeting removed, and how many words
 * that took.
 *
 * NOTHING IS STRIPPED WHEN NOTHING WOULD REMAIN. A personality really can be
 * called "Yo", and an operator really can route the phrase "hey there"; a rule
 * that strips unconditionally would leave those with an empty phrase and no way
 * to be addressed at all. A greeting is only a greeting when something follows
 * it.
 *
 * One occurrence, at the head. "hey hi researcher" is not two greetings to peel
 * off — it is someone stumbling, and the second word is as likely to be part of
 * a name as not.
 */
function stripLeadingFiller(normalized: string): { text: string; wordsRemoved: number } {
  if (normalized.length === 0) return { text: normalized, wordsRemoved: 0 };
  const words = normalized.split(' ');
  // The LONGEST greeting `greetingOffsets` found — "hey there" rather than the
  // "hey" nested inside it. Sharing that function is what keeps one definition
  // of "greeting" in this file instead of two loops that must agree.
  const offsets = greetingOffsets(words);
  const wordsRemoved = offsets[offsets.length - 1] ?? 0;
  if (wordsRemoved === 0) return { text: normalized, wordsRemoved: 0 };
  return { text: words.slice(wordsRemoved).join(' '), wordsRemoved };
}

/**
 * Every place a phrase may begin in this utterance: word 0, plus one past each
 * greeting that opens it, ascending.
 *
 * MORE THAN ONE, because greetings nest. "hey there researcher" opens with
 * `hey` and with `hey there`, and only one of those offsets puts `researcher`
 * at the head — while a route whose own phrase is "hey there" (key: "there")
 * needs the other. Picking a single winner here means one of the two silently
 * stops answering, and which one depends on the order of a list.
 */
function greetingOffsets(words: readonly string[]): number[] {
  const offsets = [0];
  for (const filler of LEADING_FILLERS) {
    if (words.length <= filler.length) continue;
    if (filler.some((word, i) => words[i] !== word)) continue;
    if (!offsets.includes(filler.length)) offsets.push(filler.length);
  }
  return offsets.sort((a, b) => a - b);
}

/**
 * The canonical identity of a wake phrase: normalized, greeting removed.
 *
 * Two phrases with the same key are the SAME TRIGGER — "hey engineer" and
 * "engineer" both answer to both sentences — so this is what a caller must key
 * a "is this phrase already claimed?" check on. Keying on the raw phrase would
 * let a config route "hey engineer" and a synthesized route "engineer" coexist,
 * and one spoken sentence would then match two rows.
 */
export function wakePhraseKey(phrase: string): string {
  return stripLeadingFiller(normalizeUtterance(phrase)).text;
}

/**
 * Levenshtein distance, abandoned as soon as it exceeds `max` (returns
 * `max + 1`). Bounded because the caller only ever asks "is this within
 * tolerance?", and the unbounded answer costs the full matrix for a pair that
 * diverged in the first two characters.
 */
export function boundedLevenshtein(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0] ?? i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (curr[j - 1] ?? Number.MAX_SAFE_INTEGER) + 1,
        (prev[j] ?? Number.MAX_SAFE_INTEGER) + 1,
        (prev[j - 1] ?? Number.MAX_SAFE_INTEGER) + cost,
      );
      curr[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length] ?? max + 1;
}

/** Edits a word of this length tolerates at this sensitivity. */
function wordTolerance(length: number, sensitivity: number): number {
  const raw = Math.round(sensitivity * length * EDITS_PER_CHAR);
  return Math.max(0, Math.min(MAX_WORD_EDITS, raw));
}

/**
 * Total edits between a phrase and the utterance starting at `offset`, or null
 * when any word is further off than its own tolerance allows.
 *
 * Word-aligned on purpose. Comparing whole strings makes "hey engine room" and
 * "hey engineer" two edits apart — the same distance as a genuine typo — and a
 * wake surface that cannot tell a truncated word from a mistyped one fires on
 * half the sentences in the room. Per-word tolerance separates them: hearing
 * "engine" where the phrase says "engineer" is two edits, over the budget an
 * eight-character word gets at the default sensitivity, while "enginer" is one
 * edit and is not.
 */
function phraseDistance(
  phraseWords: readonly string[],
  utteranceWords: readonly string[],
  offset: number,
  sensitivity: number,
): number | null {
  if (utteranceWords.length - offset < phraseWords.length) return null;
  let total = 0;
  for (let i = 0; i < phraseWords.length; i++) {
    const expected = phraseWords[i] ?? '';
    const heard = utteranceWords[offset + i] ?? '';
    const tolerance = wordTolerance(expected.length, sensitivity);
    const distance = boundedLevenshtein(expected, heard, tolerance);
    if (distance > tolerance) return null;
    total += distance;
  }
  return total;
}

/**
 * The phrase that wakes on this utterance, or null.
 *
 * Matches the HEAD of the utterance only: "so I said hey engineer to nobody" is
 * somebody talking about the agent, not to it.
 *
 * THE GREETING IS OPTIONAL, ON BOTH SIDES. The trigger is the name. Every
 * candidate phrase is reduced to its `wakePhraseKey` — greeting removed — and
 * the key is tried at every `greetingOffsets` position: at word 0, and just
 * past each greeting the utterance opens with. So a route written `hey
 * engineer` answers to "engineer, did CI pass", a route written `engineer`
 * answers to "hey engineer, did CI pass", and neither needed a second row in
 * the table. One rule applied symmetrically, rather than a special case per
 * direction — the matrix version is what rots, because the day somebody adds a
 * filler word only half the cells learn about it.
 *
 * The EARLIEST offset that fits wins a tie, so an address is never read as
 * longer than it has to be.
 *
 * Longest phrase wins — "hey swing trader" and "hey swing" are two different
 * intents, and the specific route is the one the operator meant. Compared on
 * the KEYS, so the greeting cannot make a route look more specific than it is.
 * Length ties break on the closer match.
 */
export function matchWakePhrase(
  phrases: readonly WakePhrase[],
  text: string,
  sensitivity: number = DEFAULT_WAKE_SENSITIVITY,
): WakePhraseMatch | null {
  const normalized = normalizeUtterance(text);
  if (normalized.length === 0) return null;
  const words = normalized.split(' ');
  const tolerance = Number.isFinite(sensitivity) ? sensitivity : DEFAULT_WAKE_SENSITIVITY;
  const offsets = greetingOffsets(words);

  let best: { match: WakePhraseMatch; words: number; chars: number; distance: number } | null =
    null;
  for (const candidate of phrases) {
    const key = wakePhraseKey(candidate.phrase);
    if (key.length === 0) continue;
    const phraseWords = key.split(' ');
    let aligned: { distance: number; offset: number } | null = null;
    for (const offset of offsets) {
      const distance = phraseDistance(phraseWords, words, offset, tolerance);
      if (distance === null) continue;
      if (aligned === null || distance < aligned.distance) aligned = { distance, offset };
    }
    if (aligned === null) continue;
    const distance = aligned.distance;

    const scored = {
      match: {
        id: candidate.id,
        phrase: candidate.phrase,
        confidence: Math.max(0, 1 - distance / key.length),
        wordsConsumed: aligned.offset + phraseWords.length,
      },
      words: phraseWords.length,
      chars: key.length,
      distance,
    };
    const better =
      best === null ||
      scored.words > best.words ||
      (scored.words === best.words && scored.chars > best.chars) ||
      (scored.words === best.words &&
        scored.chars === best.chars &&
        scored.distance < best.distance);
    if (better) best = scored;
  }
  return best?.match ?? null;
}

/**
 * The utterance with its wake phrase removed — what the agent should hear.
 *
 * "hey researcher, what's the weather" is one phrase of ADDRESSING followed by
 * one sentence of content, and only the second half is a question anybody
 * asked. Handing the agent the whole string makes its own name part of every
 * prompt.
 *
 * THE GREETING GOES WITH IT. "hey researcher, what's up" reaches the agent as
 * "what's up" — not "hey", and not "researcher, what's up". Whether the speaker
 * used one is the matcher's finding, not a guess made here.
 *
 * It lives HERE, beside the matcher, because the count it needs is the
 * matcher's own: `matchWakePhrase` aligns word-for-word and reports how many
 * utterance words that took in `wordsConsumed`. Recomputing it would mean a
 * second module that has to agree with `normalizeUtterance` about what a word
 * is AND with the matcher about which alignment won — and the day either
 * changes, the copy keeps compiling and starts cutting in the wrong place.
 * Nothing is re-matched: the match is an input.
 *
 * Returns the empty string when the address was the whole utterance ("hey
 * researcher" said to get attention). The CALLER decides what that means —
 * on the satellite lane it means "run the turn on the full text", because an
 * empty turn is worse than a redundant one.
 */
export function stripWakePhrase(text: string, match: WakePhraseMatch): string {
  const words = match.wordsConsumed;
  if (words <= 0) return text.trim();
  // The same character class `normalizeUtterance` collapses on, so the Nth run
  // here is the Nth word there.
  const runs = /[\p{L}\p{N}]+/gu;
  let end = 0;
  for (let i = 0; i < words; i++) {
    const run = runs.exec(text);
    if (run === null) return '';
    end = run.index + run[0].length;
  }
  return text
    .slice(end)
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim();
}
