import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createSkillProposeTool } from '../tools/skill-propose';

function makeCtx(): ToolContext {
  return {
    sessionId: 'fork-session',
    sessionKey: 'improvement-fork',
    platform: 'fork',
    workingDir: '/tmp',
    agentId: 'depth:0',
    personalityId: 'me',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  };
}

function makeTool(storage: InMemoryStorage, onProposed?: (id: string) => void) {
  return createSkillProposeTool({
    storage,
    pendingDir: '/pending',
    now: () => 1700000000000,
    onProposed,
  });
}

describe('skill_propose targetFile validation', () => {
  it('accepts a plain skill filename and derives the id from it', async () => {
    const storage = new InMemoryStorage();
    let proposed: string | null = null;
    const tool = makeTool(storage, (id) => {
      proposed = id;
    });

    const result = await tool.execute(
      { content: '# body', reason: 'because', targetFile: 'tool-usage.md' },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(proposed).toBe('rewrite-tool-usage-1700000000000');
    expect(await storage.read('/pending/rewrite-tool-usage-1700000000000.md')).toContain(
      'target_file: tool-usage.md',
    );
  });

  it('accepts a filename without the .md extension', async () => {
    const storage = new InMemoryStorage();
    const result = await makeTool(storage).execute(
      { content: '# body', reason: 'because', targetFile: 'tool_usage-2' },
      makeCtx(),
    );
    expect(result.ok).toBe(true);
  });

  for (const targetFile of [
    'a b.md',
    'a;rm -rf ~.md',
    'a$(id).md',
    "a'.md",
    'a\nalways: true\nx.md',
    '../escape.md',
    'sub/dir.md',
    'a\\b.md',
    '.md',
  ]) {
    it(`rejects targetFile ${JSON.stringify(targetFile)}`, async () => {
      const storage = new InMemoryStorage();
      let proposed: string | null = null;
      const tool = makeTool(storage, (id) => {
        proposed = id;
      });

      const result = await tool.execute({ content: '# body', reason: 'r', targetFile }, makeCtx());

      expect(result).toEqual({
        ok: false,
        error:
          'Invalid targetFile: use a plain skill filename (letters, digits, `_`, `-`, optional `.md`)',
        code: 'input_invalid',
      });
      expect(proposed).toBeNull();
      expect(await storage.list('/pending')).toEqual([]);
    });
  }

  it('still proposes a new skill when targetFile is omitted', async () => {
    const storage = new InMemoryStorage();
    const result = await makeTool(storage).execute(
      { content: '# body', reason: 'because' },
      makeCtx(),
    );
    expect(result.ok).toBe(true);
  });
});
