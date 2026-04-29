import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage, ScopedStorage } from '@ethosagent/storage-fs';
import type { ToolContext } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileTool, writeFileTool } from '../index';

// Phase 4 — personality_isolation Tier 1 #1.
//
// A personality with read_file/write_file in its toolset must NOT be able
// to reach paths outside its fs_reach allowlist. Builds a real FsStorage
// rooted at a tmp ~/.ethos look-alike, wraps it in ScopedStorage with the
// "researcher" scope, and asserts that reaching into engineer's MEMORY.md
// returns a tool error rather than the file body.

function makeCtx(opts: { workingDir: string; storage?: ToolContext['storage'] }): ToolContext {
  return {
    sessionId: 'test',
    sessionKey: 'cli:boundary',
    platform: 'cli',
    workingDir: opts.workingDir,
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
    ...(opts.storage ? { storage: opts.storage } : {}),
  };
}

describe('tools-file — fs_reach boundary enforcement', () => {
  let dataDir: string;
  let cwd: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-fsreach-'));
    cwd = await mkdtemp(join(tmpdir(), 'ethos-cwd-'));
    // Seed two personality dirs with their own MEMORY.md
    await mkdir(join(dataDir, 'personalities', 'researcher'), { recursive: true });
    await mkdir(join(dataDir, 'personalities', 'engineer'), { recursive: true });
    await writeFile(join(dataDir, 'personalities', 'researcher', 'MEMORY.md'), 'mine');
    await writeFile(join(dataDir, 'personalities', 'engineer', 'MEMORY.md'), 'theirs');
    await writeFile(join(cwd, 'project-notes.md'), 'cwd notes');
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  function researcherStorage() {
    return new ScopedStorage(new FsStorage(), {
      read: [`${join(dataDir, 'personalities', 'researcher')}/`, cwd],
      write: [`${join(dataDir, 'personalities', 'researcher')}/`, cwd],
    });
  }

  it('researcher CAN read its own MEMORY.md', async () => {
    const ctx = makeCtx({ workingDir: cwd, storage: researcherStorage() });
    const result = await readFileTool.execute(
      { path: join(dataDir, 'personalities', 'researcher', 'MEMORY.md') },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('mine');
  });

  it('researcher CANNOT read engineer\'s MEMORY.md', async () => {
    const ctx = makeCtx({ workingDir: cwd, storage: researcherStorage() });
    const result = await readFileTool.execute(
      { path: join(dataDir, 'personalities', 'engineer', 'MEMORY.md') },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Filesystem boundary/);
      expect(result.error).toContain('engineer');
    }
  });

  it('researcher CAN read files in its working dir', async () => {
    const ctx = makeCtx({ workingDir: cwd, storage: researcherStorage() });
    const result = await readFileTool.execute({ path: join(cwd, 'project-notes.md') }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('cwd notes');
  });

  it('researcher CAN write into its own personality dir', async () => {
    const ctx = makeCtx({ workingDir: cwd, storage: researcherStorage() });
    const target = join(dataDir, 'personalities', 'researcher', 'note.md');
    const result = await writeFileTool.execute({ path: target, content: 'fresh' }, ctx);
    expect(result.ok).toBe(true);
  });

  it('researcher CANNOT write into engineer\'s personality dir', async () => {
    const ctx = makeCtx({ workingDir: cwd, storage: researcherStorage() });
    const target = join(dataDir, 'personalities', 'engineer', 'sneak.md');
    const result = await writeFileTool.execute({ path: target, content: 'evil' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Filesystem boundary/);
  });

  it('default fall-through (no ctx.storage) works without restrictions — legacy callers', async () => {
    const ctx = makeCtx({ workingDir: cwd });
    const result = await readFileTool.execute(
      { path: join(dataDir, 'personalities', 'engineer', 'MEMORY.md') },
      ctx,
    );
    // Without ctx.storage the tool falls back to FsStorage with no scope —
    // matches pre-Phase-4 behaviour for tests / standalone tool usage.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('theirs');
  });
});
