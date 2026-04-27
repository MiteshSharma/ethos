import { describe, expect, it } from 'vitest';
import { chunkText, reflowChunks } from '../index';

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

describe('reflowChunks', () => {
  function makeOps() {
    const edits: Array<[string, string]> = [];
    const appends: string[] = [];
    const deletes: string[] = [];
    let nextNewId = 100;
    return {
      edits,
      appends,
      deletes,
      ops: {
        edit: async (id: string, text: string) => {
          edits.push([id, text]);
          return id;
        },
        append: async (text: string) => {
          appends.push(text);
          return String(nextNewId++);
        },
        deleteId: async (id: string) => {
          deletes.push(id);
        },
      },
    };
  }

  it('edits in place when chunk count is unchanged', async () => {
    const t = makeOps();
    const result = await reflowChunks(['a', 'b'], ['1', '2'], t.ops);
    expect(result).toEqual(['1', '2']);
    expect(t.edits).toEqual([
      ['1', 'a'],
      ['2', 'b'],
    ]);
    expect(t.appends).toEqual([]);
    expect(t.deletes).toEqual([]);
  });

  it('appends new messages when new text has more chunks', async () => {
    const t = makeOps();
    const result = await reflowChunks(['a', 'b', 'c'], ['1'], t.ops);
    expect(result).toEqual(['1', '100', '101']);
    expect(t.edits).toEqual([['1', 'a']]);
    expect(t.appends).toEqual(['b', 'c']);
    expect(t.deletes).toEqual([]);
  });

  it('deletes trailing chunks when new text has fewer chunks', async () => {
    const t = makeOps();
    const result = await reflowChunks(['only'], ['1', '2', '3'], t.ops);
    expect(result).toEqual(['1']);
    expect(t.edits).toEqual([['1', 'only']]);
    expect(t.appends).toEqual([]);
    expect(t.deletes).toEqual(['2', '3']);
  });

  it('swallows delete failures (best-effort)', async () => {
    const t = makeOps();
    const ops = {
      ...t.ops,
      deleteId: async (_id: string) => {
        throw new Error('boom');
      },
    };
    await expect(reflowChunks(['a'], ['1', '2'], ops)).resolves.toEqual(['1']);
  });
});
