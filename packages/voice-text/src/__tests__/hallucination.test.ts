import { describe, expect, it } from 'vitest';
import { isHallucination } from '../hallucination';

describe('isHallucination', () => {
  // One case per ported pattern — the union of the gateway, voice-session, and
  // web-api lists this module replaced.
  it.each([
    ['thanks-for-watching', 'Thanks for watching'],
    ['thank-you-for-watching', 'Thank you for watching!'],
    ['thanks-for-listening', 'thanks for listening'],
    ['thanks-for-viewing', 'Thanks for viewing'],
    ['please-subscribe', 'Please subscribe'],
    ['please-like-and-subscribe', 'Please like and subscribe'],
    ['subscribe-to-the-channel', 'Subscribe to the channel'],
    ['like-the-channel', 'Like the channel'],
    ['empty', ''],
    ['whitespace', '   '],
    ['dots', '...'],
    ['lone-you', 'you'],
    ['sound-cue-word', 'Music'],
    ['applause', 'applause'],
    ['laughter', 'Laughter'],
    ['bracketed', '[Music]'],
  ])('drops %s', (_name, text) => {
    expect(isHallucination(text)).toBe(true);
  });

  it('drops a repeated-phrase artifact', () => {
    expect(isHallucination('you you you you')).toBe(true);
    expect(isHallucination('Thank you. Thank you. Thank you.')).toBe(true);
  });

  it('keeps a real transcript that merely repeats a word twice', () => {
    expect(isHallucination('No, no — send the report instead')).toBe(false);
  });

  it('passes real transcripts through', () => {
    expect(isHallucination('Hello, how are you doing today?')).toBe(false);
    expect(isHallucination('Please send me the report')).toBe(false);
    expect(isHallucination('Can you check the deployment?')).toBe(false);
    expect(isHallucination('こんにちは、今日の予定を教えて。')).toBe(false);
  });

  it('does not scan long transcripts for repetition', () => {
    // Bounded input for the backreference: a 400-char repeat is left alone
    // rather than backtracked over.
    expect(isHallucination('abcdefghij '.repeat(40).trim())).toBe(false);
  });
});
