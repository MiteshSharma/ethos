/**
 * memory_read by-key tests (T12 — decision 8 "Read-by-key gap").
 *
 * Verifies the optional `key` param on memory_read reads an arbitrary
 * personality-scope memory entry by exact name, returns a clean not_found
 * result for a missing key instead of throwing, and leaves the existing
 * store-based behavior unchanged when `key` is omitted.
 */

import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createMemoryReadTool } from '../index';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'test-session',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
    ...overrides,
  };
}

describe('memory_read — by-key', () => {
  it('reads an arbitrary key’s full raw content', async () => {
    const storage = new InMemoryStorage();
    const dir = '/ethos/test-key';
    const scopeDir = `${dir}/personalities/test`;
    await storage.mkdir(scopeDir);
    await storage.write(
      `${scopeDir}/zoom-2026-08-16-143022.md`,
      'Full call transcript content here.\n',
    );

    const provider = new MarkdownFileMemoryProvider({ dir, storage });
    const tool = createMemoryReadTool(provider);
    const ctx = makeCtx({ memoryScopeId: 'personality:test' });

    const result = await tool.execute({ key: 'zoom-2026-08-16-143022.md' }, ctx);
    expect(result.ok).toBe(true);
    expect('value' in result && result.value).toBe('Full call transcript content here.');
  });

  it('returns a clean not_available result for a missing key (not a thrown exception)', async () => {
    const storage = new InMemoryStorage();
    const dir = '/ethos/test-key-missing';
    const scopeDir = `${dir}/personalities/test`;
    await storage.mkdir(scopeDir);

    const provider = new MarkdownFileMemoryProvider({ dir, storage });
    const tool = createMemoryReadTool(provider);
    const ctx = makeCtx({ memoryScopeId: 'personality:test' });

    const result = await tool.execute({ key: 'does-not-exist.md' }, ctx);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('not_available');
  });

  it('omitting key leaves store-based behavior unchanged', async () => {
    const storage = new InMemoryStorage();
    const dir = '/ethos/test-key-store';
    const scopeDir = `${dir}/personalities/test`;
    await storage.mkdir(scopeDir);
    await storage.write(`${scopeDir}/MEMORY.md`, 'Project notes.\n');

    const provider = new MarkdownFileMemoryProvider({ dir, storage });
    const tool = createMemoryReadTool(provider);
    const ctx = makeCtx({ memoryScopeId: 'personality:test' });

    const result = await tool.execute({ store: 'memory' }, ctx);
    expect(result.ok).toBe(true);
    expect('value' in result && result.value).toBe('Project notes.');
  });
});
