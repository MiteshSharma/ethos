// Transcript language detection for language-specific TTS voices (voice V2).
//
// `resolveVoicePreferences()` already prefers `personality.voice.languages[lang]`
// over the personality's default voice — but nothing ever tells it which
// language a turn was in. `SttProvider.transcribeBuffer()` returns a bare
// string with no language tag, so the transcript text is the only signal that
// exists. This supplies it, and nothing more.
//
// Deliberately not a language identifier. A general-purpose one is a model, not
// a function, and this package has zero dependencies and does no I/O. So the
// caller passes the languages the personality actually declares a voice for and
// this only ever decides between those; anything short of a confident answer is
// `undefined`, which lands the caller on the default voice — the behaviour that
// existed before this function did.

/** Ranges that identify a script outright: `[primary subtag, first, last]`. */
const SCRIPT_RANGES: ReadonlyArray<readonly [string, number, number]> = [
  ['ru', 0x0400, 0x052f], // Cyrillic + supplement
  ['ko', 0x1100, 0x11ff], // Hangul jamo
  ['ko', 0x3130, 0x318f], // Hangul compatibility jamo
  ['ko', 0xac00, 0xd7a3], // Hangul syllables
  ['ja', 0x3040, 0x30ff], // Hiragana + Katakana
  ['zh', 0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  ['zh', 0x4e00, 0x9fff], // CJK Unified Ideographs
  ['ar', 0x0600, 0x06ff], // Arabic
  ['ar', 0x0750, 0x077f], // Arabic Supplement
  ['hi', 0x0900, 0x097f], // Devanagari
  ['he', 0x0590, 0x05ff], // Hebrew
  ['el', 0x0370, 0x03ff], // Greek
  ['el', 0x1f00, 0x1fff], // Greek Extended
  ['th', 0x0e00, 0x0e7f], // Thai
];

/** A quoted name or loanword must not outvote the body of the transcript. */
const SCRIPT_SHARE_THRESHOLD = 0.3;

// ~15 high-frequency function words per Latin-script language. Space-separated
// rather than arrays so the whole table stays readable at a glance; the words
// overlap between languages on purpose — the margin rule below is what decides.
const STOPWORDS: Readonly<Record<string, string>> = {
  en: 'the of and to a in that it is was for on with as you',
  es: 'el la los las de que y en un una por con para no se',
  fr: 'le la les de des et en un une que pour dans pas qui est',
  de: 'der die das und den ist nicht ich mit auf für ein eine zu sie',
  it: 'il lo gli le di che un una per non con del sono anche come',
  pt: 'o os as de que e em um uma por com para não se do',
  nl: 'de het een en van ik te dat die in niet voor met op zijn',
};

const STOPWORD_SETS = new Map(
  Object.entries(STOPWORDS).map(([lang, words]) => [lang, new Set(words.split(' '))] as const),
);

const LETTER = /\p{L}/u;
const TOKEN_SEPARATOR = /[^\p{L}']+/u;

/** A single hit is noise; a tie between two languages is not an answer. */
const MIN_STOPWORD_HITS = 2;

/** Decisive when one non-Latin script carries the text. Undefined for Latin. */
function detectByScript(text: string): string | undefined {
  const counts = new Map<string, number>();
  let letters = 0;

  for (const char of text) {
    if (!LETTER.test(char)) continue;
    letters++;
    const cp = char.codePointAt(0) ?? 0;
    for (const [lang, first, last] of SCRIPT_RANGES) {
      if (cp >= first && cp <= last) {
        counts.set(lang, (counts.get(lang) ?? 0) + 1);
        break;
      }
    }
  }
  if (letters === 0) return undefined;

  let best: string | undefined;
  let bestCount = 0;
  for (const [lang, count] of counts) {
    if (count > bestCount) {
      best = lang;
      bestCount = count;
    }
  }
  if (best === undefined || bestCount / letters < SCRIPT_SHARE_THRESHOLD) return undefined;

  // Japanese mixes kanji with kana, and kana never appear in Chinese — so any
  // kana at all settles a Han-dominant text as Japanese.
  if (best === 'zh' && (counts.get('ja') ?? 0) > 0) return 'ja';
  return best;
}

/** Latin-script languages, scored by whole-word function-word hits. */
function detectByStopwords(text: string): string | undefined {
  const tokens = text.toLowerCase().split(TOKEN_SEPARATOR);

  let best: string | undefined;
  let bestHits = 0;
  let runnerUpHits = 0;
  for (const [lang, words] of STOPWORD_SETS) {
    let hits = 0;
    for (const token of tokens) {
      if (words.has(token)) hits++;
    }
    if (hits > bestHits) {
      runnerUpHits = bestHits;
      best = lang;
      bestHits = hits;
    } else if (hits > runnerUpHits) {
      runnerUpHits = hits;
    }
  }
  if (best === undefined || bestHits < MIN_STOPWORD_HITS || bestHits === runnerUpHits) {
    return undefined;
  }
  return best;
}

export interface DetectLanguageOptions {
  /**
   * Tags to choose between — typically `Object.keys(personality.voice.languages)`.
   * Matched on the primary subtag, and the ORIGINAL tag is returned, so a
   * personality keyed `es-419` still gets its own key back and the lookup hits.
   */
  candidates: readonly string[];
}

/**
 * Best-effort BCP-47 primary subtag for a transcript, chosen from a CANDIDATE
 * list.
 *
 * Constrained on purpose. A general-purpose language identifier is a model, not
 * a function, and a wrong guess here picks the wrong voice — so the caller
 * passes the languages the personality actually declares a voice for, and this
 * only ever decides between those. No candidates, or no confident answer,
 * returns undefined and the caller falls through to the personality's default
 * voice, which is the same behaviour as before this existed.
 */
export function detectLanguage(text: string, opts: DetectLanguageOptions): string | undefined {
  if (text.trim().length === 0) return undefined;

  // First spelling wins, so the returned tag is the caller's own map key.
  const byPrimarySubtag = new Map<string, string>();
  for (const tag of opts.candidates) {
    const primary = tag.toLowerCase().split(/[-_]/)[0] ?? '';
    if (primary.length > 0 && !byPrimarySubtag.has(primary)) byPrimarySubtag.set(primary, tag);
  }
  if (byPrimarySubtag.size === 0) return undefined;

  const detected = detectByScript(text) ?? detectByStopwords(text);
  return detected === undefined ? undefined : byPrimarySubtag.get(detected);
}
