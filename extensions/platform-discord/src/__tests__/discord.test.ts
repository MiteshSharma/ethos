import { describe, expect, it } from 'vitest';
import { chunkText } from '../index';

describe('Discord chunkText', () => {
  it('returns single chunk when within limit', () => {
    expect(chunkText('hello', 2000)).toEqual(['hello']);
  });

  it('splits long text at newline boundary', () => {
    const text = 'line one\n'.repeat(300); // ~2700 chars
    const chunks = chunkText(text, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000);
  });

  it('splits at character limit when no newline', () => {
    const text = 'x'.repeat(3000);
    const chunks = chunkText(text, 2000);
    expect(chunks.length).toBe(2);
    expect(chunks.join('')).toBe(text);
  });

  it('preserves all content', () => {
    const text = 'Hello world. '.repeat(200);
    const chunks = chunkText(text, 2000);
    expect(chunks.join('')).toBe(text);
  });
});
