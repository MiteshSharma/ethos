import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AllowlistRepository } from '../../repositories/allowlist.repository';

describe('AllowlistRepository', () => {
  let dir: string;
  let repo: AllowlistRepository;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-allowlist-'));
    repo = new AllowlistRepository({ dataDir: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('list() returns empty when the file does not exist', async () => {
    expect(await repo.list()).toEqual([]);
  });

  it('add() then list() round-trips with createdAt set', async () => {
    await repo.add({ toolName: 'terminal', scope: 'any-args', args: null });
    const entries = await repo.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.toolName).toBe('terminal');
    expect(entries[0]?.scope).toBe('any-args');
    expect(typeof entries[0]?.createdAt).toBe('string');
  });

  it('matches() returns true for any-args entries regardless of payload', async () => {
    await repo.add({ toolName: 'terminal', scope: 'any-args', args: null });
    expect(await repo.matches('terminal', { command: 'rm -rf /tmp/x' })).toBe(true);
    expect(await repo.matches('terminal', { command: 'ls' })).toBe(true);
    expect(await repo.matches('web_fetch', {})).toBe(false);
  });

  it('matches() exact-args ignores key ordering', async () => {
    await repo.add({
      toolName: 'terminal',
      scope: 'exact-args',
      args: { a: 1, b: 2 },
    });
    expect(await repo.matches('terminal', { b: 2, a: 1 })).toBe(true);
    expect(await repo.matches('terminal', { a: 1 })).toBe(false);
  });

  it('matches() exact-args handles nested objects + arrays', async () => {
    await repo.add({
      toolName: 'edit',
      scope: 'exact-args',
      args: { path: '/x', edits: [{ kind: 'insert', text: 'hi' }] },
    });
    expect(
      await repo.matches('edit', {
        edits: [{ text: 'hi', kind: 'insert' }],
        path: '/x',
      }),
    ).toBe(true);
  });

  it('writes are atomic — the destination only contains valid JSON', async () => {
    await repo.add({ toolName: 'a', scope: 'any-args', args: null });
    await repo.add({ toolName: 'b', scope: 'any-args', args: null });
    const path = join(dir, 'allowlist.json');
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as { entries: Array<{ toolName: string }> };
    expect(parsed.entries.map((e) => e.toolName)).toEqual(['a', 'b']);
  });

  it('concurrent add() calls do not lose entries', async () => {
    await Promise.all([
      repo.add({ toolName: 't1', scope: 'any-args', args: null }),
      repo.add({ toolName: 't2', scope: 'any-args', args: null }),
      repo.add({ toolName: 't3', scope: 'any-args', args: null }),
    ]);
    const entries = await repo.list();
    expect(entries.map((e) => e.toolName).sort()).toEqual(['t1', 't2', 't3']);
  });
});
