import { describe, expect, it } from 'vitest';
import { chunkText } from '../index';

describe('chunkText', () => {
  it('returns single chunk when text is within limit', () => {
    expect(chunkText('hello', 100)).toEqual(['hello']);
  });

  it('splits at newline boundary when possible', () => {
    const text = 'line one\nline two\nline three';
    // Force a split after "line one\n" (limit = 10)
    const chunks = chunkText(text, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text); // no content lost
  });

  it('splits at space boundary when no newline available', () => {
    const text = 'word1 word2 word3 word4';
    const chunks = chunkText(text, 12);
    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(12);
    }
  });

  it('handles text longer than 4096', () => {
    const text = 'x'.repeat(5000);
    const chunks = chunkText(text, 4096);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(4096);
    expect(chunks[1].length).toBe(904);
    expect(chunks.join('')).toBe(text);
  });

  it('preserves all content across chunks', () => {
    const text = 'A'.repeat(100) + '\n' + 'B'.repeat(100) + '\n' + 'C'.repeat(100);
    const chunks = chunkText(text, 150);
    expect(chunks.join('')).toBe(text);
  });
});
