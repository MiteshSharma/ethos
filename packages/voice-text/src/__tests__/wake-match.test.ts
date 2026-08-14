// `stripWakePhrase` — the counterpart of the matcher — and the greeting rule
// that decides where an address ends.
//
// The matcher answers "who was addressed". This answers "what did they
// actually say", and it has to agree with the matcher about where the address
// ended. That agreement is the whole risk: the two count words the same way
// only because they share `normalizeUtterance`, so these cases are written
// around the places where raw text and normalized text drift apart —
// punctuation between the phrase and the question, apostrophes inside a word,
// non-Latin script, and runs of whitespace.
//
// The matcher itself is exercised through its callers (the satellite's
// transcript engine and the browser's phrase tester).

import { describe, expect, it } from 'vitest';
import { DEFAULT_WAKE_SENSITIVITY, matchWakePhrase, stripWakePhrase } from '../wake-match';

const ROUTES = [
  { id: 'res', phrase: 'hey researcher' },
  { id: 'trader', phrase: 'hey swing trader' },
];

/** Match then strip, the way the satellite lane does it. */
function heard(text: string, phrases = ROUTES): { id: string; rest: string } | null {
  const match = matchWakePhrase(phrases, text);
  return match === null ? null : { id: match.id, rest: stripWakePhrase(text, match) };
}

describe('stripWakePhrase', () => {
  it('removes the address and the punctuation that separated it', () => {
    expect(heard("hey researcher, what's the weather")).toEqual({
      id: 'res',
      // The comma goes with the address, and the apostrophe inside "what's"
      // stays: normalization splits it into two words, so a word-count taken
      // from the normalized string would cut here without this.
      rest: "what's the weather",
    });
  });

  it('removes only the words the matcher consumed, for the longest phrase that won', () => {
    expect(heard('hey swing trader how are my positions')).toEqual({
      id: 'trader',
      rest: 'how are my positions',
    });
  });

  it('returns empty for a bare phrase — the caller decides what that means', () => {
    expect(heard('hey researcher')).toEqual({ id: 'res', rest: '' });
    expect(heard('hey researcher?')).toEqual({ id: 'res', rest: '' });
  });

  it('survives a near miss the matcher forgave', () => {
    // The matcher tolerates an edit inside a word; the strip counts words, not
    // characters, so it cuts in the same place regardless.
    const text = 'hey researcer tell me more';
    const match = matchWakePhrase(ROUTES, text);
    expect(match?.id).toBe('res');
    expect(match && stripWakePhrase(text, match)).toBe('tell me more');
  });

  it('collapses nothing it was not asked to — inner spacing of the remainder is kept', () => {
    const match = matchWakePhrase(ROUTES, 'hey  researcher   what   now');
    expect(match && stripWakePhrase('hey  researcher   what   now', match)).toBe('what   now');
  });

  it('works in a non-Latin script, because the character class is Unicode-aware', () => {
    const phrases = [{ id: 'ja', phrase: 'ねえ 研究者' }];
    expect(heard('ねえ 研究者 天気は', phrases)).toEqual({ id: 'ja', rest: '天気は' });
  });

  it('is unfazed by a phrase that normalizes to nothing', () => {
    // Not reachable through the matcher (it skips such candidates), but the
    // function is exported and must not slice on a count of zero words.
    expect(
      stripWakePhrase('  say something  ', {
        id: 'x',
        phrase: '!!!',
        confidence: 1,
        wordsConsumed: 0,
      }),
    ).toBe('say something');
  });
});

// The greeting rule.
//
// The trigger is the NAME. "hey" was the fragile half — speech-to-text renders
// it as "hay", as "a", as "eh", or drops it — so it became optional, and
// optional SYMMETRICALLY: the same rule strips it from the route phrase and
// from the utterance, which is why there is no matrix of cases below, only one
// property checked from both ends.

/** The default table now: one bare name per personality. */
const NAMES = [
  { id: 'res', phrase: 'researcher' },
  { id: 'swing', phrase: 'swing' },
  { id: 'trader', phrase: 'swing trader' },
];

describe('matchWakePhrase — the greeting is optional', () => {
  it('wakes on the bare name', () => {
    expect(heard('researcher, what is the latest on X', NAMES)).toEqual({
      id: 'res',
      rest: 'what is the latest on X',
    });
  });

  it('wakes on the same name behind any greeting, and strips the greeting too', () => {
    for (const greeting of ['hey', 'hi', 'hello', 'ok', 'okay', 'yo', 'hey there']) {
      expect(heard(`${greeting} researcher, what is the latest on X`, NAMES), greeting).toEqual({
        id: 'res',
        rest: 'what is the latest on X',
      });
    }
  });

  it('is symmetric: a route WRITTEN with a greeting answers to the bare name', () => {
    // The operator's config says `phrase: hey engineer`. Nothing was added to
    // their table, and "engineer, …" reaches them anyway — the same rule that
    // lets a bare-name route answer to "hey engineer".
    const configured = [{ id: 'eng', phrase: 'hey engineer' }];
    expect(heard('engineer, did CI pass', configured)).toEqual({ id: 'eng', rest: 'did CI pass' });
    expect(heard('hey engineer, did CI pass', configured)).toEqual({
      id: 'eng',
      rest: 'did CI pass',
    });
  });

  it('keeps a bare address strippable to nothing — the lane falls back to the full text', () => {
    // `SatelliteLane.address` runs the turn on the whole utterance when the
    // remainder is empty: someone who says only a name wants attention, and an
    // empty turn is worse than a redundant one.
    expect(heard('researcher', NAMES)).toEqual({ id: 'res', rest: '' });
    expect(heard('hey researcher', NAMES)).toEqual({ id: 'res', rest: '' });
    expect(heard('hey there researcher!', NAMES)).toEqual({ id: 'res', rest: '' });
  });

  it('still matches the HEAD only — a name in the middle of a sentence is not an address', () => {
    expect(matchWakePhrase(NAMES, 'the researcher said X')).toBeNull();
    expect(matchWakePhrase(NAMES, 'so I said hey researcher to nobody')).toBeNull();
  });

  it('wakes nothing on a greeting with no name behind it', () => {
    for (const greeting of ['hey', 'hi', 'hello', 'ok', 'okay', 'yo', 'hey there']) {
      expect(matchWakePhrase(NAMES, greeting), greeting).toBeNull();
    }
  });

  it('still prefers the longer phrase, greeting or no greeting', () => {
    expect(heard('hey swing trader, how are my positions', NAMES)).toEqual({
      id: 'trader',
      rest: 'how are my positions',
    });
    expect(heard('swing trader, how are my positions', NAMES)).toEqual({
      id: 'trader',
      rest: 'how are my positions',
    });
    expect(heard('hey swing by later', NAMES)).toEqual({ id: 'swing', rest: 'by later' });
  });

  it('keeps a route whose phrase IS a greeting reachable', () => {
    // "hey there" reduces to "there" — a greeting is only stripped while
    // something remains — and BOTH spellings still reach it, because the
    // utterance is tried at every greeting boundary rather than one.
    const greeter = [{ id: 'ht', phrase: 'hey there' }];
    expect(heard('hey there, what time is it', greeter)).toEqual({
      id: 'ht',
      rest: 'what time is it',
    });
    expect(heard('there, what time is it', greeter)).toEqual({ id: 'ht', rest: 'what time is it' });
    // …and so does a personality actually named "Yo".
    expect(heard('yo, what time is it', [{ id: 'yo', phrase: 'Yo' }])).toEqual({
      id: 'yo',
      rest: 'what time is it',
    });
  });
});

// SHORT NAMES are the risk a bare-name trigger creates, and `em` is a real
// personality on a real machine. "um", "hmm" and "them" all live within a
// couple of edits of it, and somebody thinking out loud must not open a turn.
//
// The protection is the per-word tolerance that was already there:
// `round(sensitivity × length × 0.25)`, capped at 2. A two-character word gets
// ZERO edits at the default sensitivity, so it is exact-match-only — which is
// why no minimum length is enforced on an implicit route. A length floor would
// be a silent exclusion ("why does my agent not answer?") in exchange for
// protection the tolerance curve already provides.
describe('matchWakePhrase — a two-letter name is exact-match-only', () => {
  const em = [{ id: 'em', phrase: 'em' }];

  it('does not wake on a near miss at the default sensitivity', () => {
    for (const noise of ['um', 'um…', 'hmm', 'them', 'me', 'am']) {
      expect(matchWakePhrase(em, `${noise} what was I saying`), noise).toBeNull();
    }
  });

  it('wakes on the name itself, greeting or not', () => {
    expect(heard('em, what was I saying', em)).toEqual({ id: 'em', rest: 'what was I saying' });
    expect(heard('hey em, what was I saying', em)).toEqual({ id: 'em', rest: 'what was I saying' });
  });

  it('pins the tolerance curve that makes the above true', () => {
    // If EDITS_PER_CHAR, the cap, or the rounding ever move, a two-letter name
    // starts accepting a one-edit neighbour and this fails first.
    expect(matchWakePhrase(em, 'um', 0.25)).toBeNull();
    expect(matchWakePhrase(em, 'um', DEFAULT_WAKE_SENSITIVITY)).toBeNull();
    expect(matchWakePhrase(em, 'um', 0.75)).toBeNull();
    // At sensitivity 1.0 the operator has asked for one edit per four
    // characters, and a two-letter word rounds up to one. That is the
    // operator's choice, made out loud in `voice.wake.sensitivity`, and it is
    // recorded here so the trade is visible rather than discovered in a room.
    expect(matchWakePhrase(em, 'um', 1)?.id).toBe('em');
  });
});
