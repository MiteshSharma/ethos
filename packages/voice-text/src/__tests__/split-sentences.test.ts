import { describe, expect, it } from 'vitest';
import { SentenceChunker } from '../sentence-chunker';
import { DEFAULT_SOFT_BREAK_CHARS, splitSentences } from '../split-sentences';
import { truncateAtSentenceBoundary } from '../truncate';

describe('splitSentences', () => {
  it('splits on terminators followed by whitespace, keeping the remainder', () => {
    expect(splitSentences('Hello there. How are ')).toEqual({
      sentences: ['Hello there.'],
      rest: 'How are ',
    });
  });

  it('does not split a decimal or a terminator with no trailing whitespace', () => {
    expect(splitSentences('pi is 3.14 today')).toEqual({ sentences: [], rest: 'pi is 3.14 today' });
    expect(splitSentences('Done.')).toEqual({ sentences: [], rest: 'Done.' });
  });

  it('handles multiple sentences and clustered terminators', () => {
    expect(splitSentences('Yes! No? Maybe. tail')).toEqual({
      sentences: ['Yes!', 'No?', 'Maybe.'],
      rest: 'tail',
    });
  });

  it('keeps a closing quote with the sentence it closes', () => {
    expect(splitSentences('She said "go." Then she left. ')).toEqual({
      sentences: ['She said "go."', 'Then she left.'],
      rest: '',
    });
  });

  describe('abbreviations', () => {
    it.each([
      ['Mr.', 'Mr. Smith arrived. '],
      ['Dr.', 'Dr. Smith arrived. '],
      ['etc.', 'Bring rope, rations, etc. and a map. '],
      ['e.g.', 'Use a fast model, e.g. a local one, for voice. '],
      ['i.e.', 'The fast lane, i.e. the voice personality, answers first. '],
    ])('does not split after %s', (_name, text) => {
      const { sentences } = splitSentences(text);
      expect(sentences).toEqual([text.trim()]);
    });
  });

  describe('CJK', () => {
    it('splits on full-width terminators with no whitespace', () => {
      expect(splitSentences('こんにちは。元気ですか？はい！')).toEqual({
        sentences: ['こんにちは。', '元気ですか？', 'はい！'],
        rest: '',
      });
    });

    it('splits mixed CJK and Latin text', () => {
      expect(splitSentences('了解しました。Done. ')).toEqual({
        sentences: ['了解しました。', 'Done.'],
        rest: '',
      });
    });

    it('keeps a CJK closing bracket with its sentence', () => {
      expect(splitSentences('彼は「はい。」と言った。')).toEqual({
        sentences: ['彼は「はい。」', 'と言った。'],
        rest: '',
      });
    });
  });

  describe('soft break', () => {
    it('breaks at the first whitespace at or after the threshold', () => {
      const long = `${'word '.repeat(20).trim()} end`;
      const { sentences, rest } = splitSentences(long);
      expect(sentences.length).toBeGreaterThan(0);
      const first = sentences[0] ?? '';
      expect(first.length).toBeGreaterThanOrEqual(DEFAULT_SOFT_BREAK_CHARS - 5);
      expect(first.length).toBeLessThan(DEFAULT_SOFT_BREAK_CHARS + 10);
      expect([...sentences, rest].join(' ').replace(/\s+/g, ' ').trim()).toBe(long);
    });

    it('prefers a terminator that arrives before the threshold', () => {
      const text = `Short one. ${'word '.repeat(20)}`;
      expect(splitSentences(text).sentences[0]).toBe('Short one.');
    });

    it('does not break short text', () => {
      expect(splitSentences('no terminator here')).toEqual({
        sentences: [],
        rest: 'no terminator here',
      });
    });

    it('can be disabled', () => {
      const long = 'word '.repeat(40);
      expect(splitSentences(long, { softBreakChars: 0 })).toEqual({ sentences: [], rest: long });
    });
  });
});

describe('SentenceChunker', () => {
  it('flushes a complete sentence on a boundary', () => {
    const c = new SentenceChunker();
    expect(c.push('Hello world. ')).toEqual(['Hello world.']);
  });

  it('assembles a sentence from streamed deltas', () => {
    const c = new SentenceChunker();
    expect(c.push('Hel')).toEqual([]);
    expect(c.push('lo. Wor')).toEqual(['Hello.']);
    expect(c.push('ld! ')).toEqual(['World!']);
  });

  it('does not flush mid-sentence', () => {
    const c = new SentenceChunker();
    expect(c.push('Hello wor')).toEqual([]);
    expect(c.push('ld')).toEqual([]);
  });

  it('does not flush a terminator with no trailing whitespace yet', () => {
    const c = new SentenceChunker();
    expect(c.push('Ready.')).toEqual([]);
    expect(c.push(' Go!')).toEqual(['Ready.']);
  });

  it('emits multiple sentences from a single push', () => {
    const c = new SentenceChunker();
    expect(c.push('One. Two. Three. ')).toEqual(['One.', 'Two.', 'Three.']);
  });

  it('handles question and exclamation boundaries', () => {
    const c = new SentenceChunker();
    expect(c.push('Really? Yes! ')).toEqual(['Really?', 'Yes!']);
  });

  it('does not split on a known abbreviation', () => {
    const c = new SentenceChunker();
    expect(c.push('Dr. Smith arrived. ')).toEqual(['Dr. Smith arrived.']);
  });

  it('emits a CJK sentence without waiting for whitespace', () => {
    const c = new SentenceChunker();
    expect(c.push('こんにちは。')).toEqual(['こんにちは。']);
  });

  it('flush() emits the buffered remainder', () => {
    const c = new SentenceChunker();
    expect(c.push('No terminator here')).toEqual([]);
    expect(c.flush()).toBe('No terminator here');
  });

  it('flush() returns null when empty', () => {
    const c = new SentenceChunker();
    c.push('Done. ');
    expect(c.flush()).toBeNull();
  });
});

describe('truncateAtSentenceBoundary', () => {
  it('returns text unchanged when under limit', () => {
    expect(truncateAtSentenceBoundary('Hello.', 100)).toBe('Hello.');
  });

  it('truncates at sentence boundary', () => {
    const text = 'First sentence. Second sentence. Third sentence.';
    expect(truncateAtSentenceBoundary(text, 20)).toBe('First sentence.');
  });

  it('falls back to word boundary', () => {
    const text = 'This is a long sentence without any periods';
    expect(truncateAtSentenceBoundary(text, 25)).toBe('This is a long sentence');
  });

  it('truncates at a full-width terminator', () => {
    const text = 'これは最初の文です。これは二番目の文です。';
    expect(truncateAtSentenceBoundary(text, 15)).toBe('これは最初の文です。');
  });
});
