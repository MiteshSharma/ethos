import { describe, expect, it } from 'vitest';
import { sanitizeForSpeech } from '../sanitize';

describe('sanitizeForSpeech', () => {
  describe('never reaches TTS', () => {
    it('removes think blocks', () => {
      expect(sanitizeForSpeech('<think>secret plan</think>Here you go.')).toBe('Here you go.');
      expect(sanitizeForSpeech('<thinking>\nstep 1\n</thinking>\nDone.')).toBe('Done.');
    });

    it('removes an unterminated think block (cut-off stream)', () => {
      expect(sanitizeForSpeech('Sure. <think>still reasoning about')).toBe('Sure.');
    });

    it('removes fenced code blocks', () => {
      expect(sanitizeForSpeech('Hello\n```js\nconst x = 1;\n```\nWorld')).toBe('Hello\n\nWorld');
    });

    it('removes an unterminated fence', () => {
      expect(sanitizeForSpeech('Here it is:\n```js\nconst x = 1;')).toBe('Here it is:');
    });

    it.each([
      ['absolute posix', 'I edited /Users/dana/project/src/index.ts today.'],
      ['relative dot', 'I edited ./src/index.ts today.'],
      ['parent dot', 'I edited ../shared/util.ts today.'],
      ['home', 'I edited ~/.ethos/config.yaml today.'],
      ['bare relative', 'I edited src/features/voice/index.ts today.'],
      ['windows', 'I edited C:\\Users\\dana\\notes.txt today.'],
    ])('removes a %s file path', (_name, text) => {
      const out = sanitizeForSpeech(text);
      expect(out).toBe('I edited today.');
    });

    it('removes urls', () => {
      expect(sanitizeForSpeech('See https://example.com/docs/page?q=1 for details.')).toBe(
        'See for details.',
      );
    });

    it('removes emoji', () => {
      expect(sanitizeForSpeech('Shipped it 🚀🎉 — all green ✅')).toBe('Shipped it — all green');
      expect(sanitizeForSpeech('Nice work 👍🏽 team 👩‍💻')).toBe('Nice work team');
    });

    it('removes media directives', () => {
      expect(sanitizeForSpeech('Here it is: ![a chart](chart.png) — see it?')).toBe(
        'Here it is: — see it?',
      );
      expect(sanitizeForSpeech('Listen: <audio src="a.ogg"></audio> done')).toBe('Listen: done');
      expect(sanitizeForSpeech('Look <img src="x.png" /> here')).toBe('Look here');
    });
  });

  describe('markdown syntax', () => {
    it('removes inline code', () => {
      expect(sanitizeForSpeech('Use `foo()` here')).toBe('Use here');
    });

    it('extracts link text', () => {
      expect(sanitizeForSpeech('See [docs](http://example.com)')).toBe('See docs');
    });

    it('removes heading markers', () => {
      expect(sanitizeForSpeech('## Title')).toBe('Title');
    });

    it('removes bold and italic', () => {
      expect(sanitizeForSpeech('**bold** and *italic*')).toBe('bold and italic');
    });

    it('removes list markers and blockquotes', () => {
      expect(sanitizeForSpeech('- one\n- two\n\n> quoted')).toBe('one\ntwo\n\nquoted');
      expect(sanitizeForSpeech('1. first\n2. second')).toBe('first\nsecond');
    });

    it('removes a horizontal rule but keeps a prose dash', () => {
      expect(sanitizeForSpeech('Before\n\n---\n\nAfter')).toBe('Before\n\nAfter');
      expect(sanitizeForSpeech('Well — maybe.')).toBe('Well — maybe.');
    });
  });

  describe('leaves prose alone', () => {
    it('passes plain text through', () => {
      expect(sanitizeForSpeech('Hello world')).toBe('Hello world');
    });

    it('keeps ordinary punctuation', () => {
      const prose = "Wait, really? Yes — I'm sure; the build passed!";
      expect(sanitizeForSpeech(prose)).toBe(prose);
    });

    it('keeps CJK prose', () => {
      expect(sanitizeForSpeech('こんにちは。今日の予定を教えて。')).toBe(
        'こんにちは。今日の予定を教えて。',
      );
    });

    it('is idempotent', () => {
      const once = sanitizeForSpeech('**Done** — see `x` at ./a/b.ts 🎉');
      expect(sanitizeForSpeech(once)).toBe(once);
    });
  });
});
