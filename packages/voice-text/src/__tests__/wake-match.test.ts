// `stripWakePhrase` — the counterpart of the matcher.
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
import { matchWakePhrase, stripWakePhrase } from '../wake-match';

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
    expect(stripWakePhrase('  say something  ', { id: 'x', phrase: '!!!', confidence: 1 })).toBe(
      'say something',
    );
  });
});
