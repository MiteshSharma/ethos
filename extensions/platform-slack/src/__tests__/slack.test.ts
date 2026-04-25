import { describe, expect, it } from 'vitest';
import { chunkText } from '../index';

describe('Slack chunkText', () => {
  it('returns single chunk within limit', () => {
    expect(chunkText('hello', 3000)).toEqual(['hello']);
  });

  it('splits at newline boundary', () => {
    const text = 'paragraph\n'.repeat(400); // ~4000 chars
    const chunks = chunkText(text, 3000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(3000);
  });

  it('preserves all content', () => {
    const text = 'word '.repeat(1000);
    const chunks = chunkText(text, 3000);
    expect(chunks.join('')).toBe(text);
  });
});
