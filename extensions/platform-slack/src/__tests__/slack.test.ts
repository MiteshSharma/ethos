import { describe, expect, it } from 'vitest';
import { chunkText, reflowChunks } from '../index';

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

describe('reflowChunks', () => {
  it('edits, appends, and deletes as needed', async () => {
    const edits: Array<[string, string]> = [];
    const appends: string[] = [];
    const deletes: string[] = [];
    const ops = {
      edit: async (id: string, text: string) => {
        edits.push([id, text]);
        return id;
      },
      append: async (text: string) => {
        appends.push(text);
        return `new-${appends.length}`;
      },
      deleteId: async (id: string) => {
        deletes.push(id);
      },
    };

    // Three new chunks, two existing → 2 edits + 1 append
    const ids = await reflowChunks(['x', 'y', 'z'], ['a', 'b'], ops);
    expect(ids).toEqual(['a', 'b', 'new-1']);
    expect(edits).toEqual([
      ['a', 'x'],
      ['b', 'y'],
    ]);
    expect(appends).toEqual(['z']);
    expect(deletes).toEqual([]);

    // Now shrink: one new chunk, two existing → 1 edit + 1 delete
    edits.length = 0;
    appends.length = 0;
    deletes.length = 0;
    const ids2 = await reflowChunks(['only'], ['a', 'b'], ops);
    expect(ids2).toEqual(['a']);
    expect(edits).toEqual([['a', 'only']]);
    expect(deletes).toEqual(['b']);
  });
});
