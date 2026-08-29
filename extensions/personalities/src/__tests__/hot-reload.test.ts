import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { Storage } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { FilePersonalityRegistry } from '../index';

const DIR = '/data/personalities';

async function writePersonality(
  storage: Storage,
  id: string,
  opts: { name: string; description?: string; soul?: string },
): Promise<void> {
  const pdir = join(DIR, id);
  await storage.mkdir(pdir);
  await storage.write(
    join(pdir, 'config.yaml'),
    `name: ${opts.name}\ndescription: ${opts.description ?? 'test'}\n`,
  );
  await storage.write(join(pdir, 'SOUL.md'), opts.soul ?? `# ${opts.name}\n`);
  await storage.write(join(pdir, 'toolset.yaml'), '- read_file\n');
}

describe('personality hot-reload — refresh-on-resolve', () => {
  it('criterion 1 — drop-a-directory hot-load: a new personality resolves after refresh, no restart', async () => {
    const storage = new InMemoryStorage();
    const registry = new FilePersonalityRegistry(storage);

    // Boot-load an empty personalities dir.
    await storage.mkdir(DIR);
    await registry.loadFromDirectory(DIR);
    expect(registry.get('strategist')).toBeUndefined();

    // Drop a new personality directory on disk after boot.
    await writePersonality(storage, 'strategist', { name: 'Strategist' });

    // Refresh (the seam callers do this before resolving a turn).
    await registry.loadFromDirectory(DIR);

    const resolved = registry.get('strategist');
    expect(resolved).toBeDefined();
    expect(resolved?.name).toBe('Strategist');
  });

  it('criterion 2 — edit-then-turn: an edited personality serves new content after refresh (fingerprint invalidated)', async () => {
    const storage = new InMemoryStorage();
    const registry = new FilePersonalityRegistry(storage);

    await writePersonality(storage, 'sage', { name: 'Sage v1', soul: '# Sage\n\nv1 body\n' });
    await registry.loadFromDirectory(DIR);
    expect(registry.get('sage')?.name).toBe('Sage v1');
    expect(await registry.readSoulMd('sage')).toContain('v1 body');

    // Edit config.yaml (name) AND SOUL.md on disk — a rewrite bumps mtime, so
    // the 4-file fingerprint changes and loadOne re-parses.
    await storage.write(join(DIR, 'sage', 'config.yaml'), 'name: Sage v2\ndescription: test\n');
    await storage.write(join(DIR, 'sage', 'SOUL.md'), '# Sage\n\nv2 body\n');

    await registry.loadFromDirectory(DIR);
    expect(registry.get('sage')?.name).toBe('Sage v2');
    expect(await registry.readSoulMd('sage')).toContain('v2 body');
  });

  it('criterion 3 — cross-process: create via instance A, refresh() on instance B, resolve via B', async () => {
    const storage = new InMemoryStorage();
    // Instance A owns the writable user dir (CRUD enabled); B is a bare reader
    // over the SAME storage — simulating two processes sharing one disk.
    const a = new FilePersonalityRegistry(storage, '/data');
    const b = new FilePersonalityRegistry(storage);

    await a.loadFromDirectory(DIR);
    await b.loadFromDirectory(DIR);
    expect(b.get('nova')).toBeUndefined();

    await a.create({
      id: 'nova',
      name: 'Nova',
      toolset: ['read_file'],
      soulMd: '# Nova\n',
    });

    // B has never heard of nova until it refreshes from disk.
    expect(b.get('nova')).toBeUndefined();
    await b.loadFromDirectory(DIR);

    const resolved = b.get('nova');
    expect(resolved).toBeDefined();
    expect(resolved?.name).toBe('Nova');
  });

  it('criterion 7 — delete-then-refresh: a removed personality stops resolving (config + mcp policy); other-dir personalities survive', async () => {
    const storage = new InMemoryStorage();
    const registry = new FilePersonalityRegistry(storage);

    // A "built-in"-style personality loaded from a SEPARATE directory (a
    // different parent than the user dir — mirrors the package data dir). It
    // must survive a reconciliation scoped to the user dir.
    const BUILTIN_DIR = '/builtins';
    await storage.mkdir(join(BUILTIN_DIR, 'sage'));
    await storage.write(
      join(BUILTIN_DIR, 'sage', 'config.yaml'),
      'name: Sage\ndescription: test\n',
    );
    await storage.write(join(BUILTIN_DIR, 'sage', 'SOUL.md'), '# Sage\n');
    await registry.loadFromDirectory(BUILTIN_DIR);
    expect(registry.get('sage')).toBeDefined();

    // A user personality that also ships an mcp.yaml, so we can assert the
    // policy is dropped on deletion (the ghost-policy bug).
    await writePersonality(storage, 'ephemeral', { name: 'Ephemeral' });
    await storage.write(
      join(DIR, 'ephemeral', 'mcp.yaml'),
      'servers:\n  linear:\n    tools:\n      - list_issues\n',
    );
    await registry.loadFromDirectory(DIR);
    expect(registry.get('ephemeral')).toBeDefined();
    expect(registry.getMcpPolicy('ephemeral')).toBeDefined();

    // Delete the ONLY user personality directory, then refresh. The dir is now
    // empty — reconciliation must still run (no early return).
    await storage.remove(join(DIR, 'ephemeral'), { recursive: true });
    await registry.loadFromDirectory(DIR);

    // Removed everywhere: config AND the sibling mcp policy.
    expect(registry.get('ephemeral')).toBeUndefined();
    expect(registry.getMcpPolicy('ephemeral')).toBeUndefined();

    // The other-dir personality survived the user-dir refresh — built-ins are
    // never nuked by a user-dir reconciliation.
    expect(registry.get('sage')).toBeDefined();
  });

  it('installing the first skill into a personality with no skills/ dir invalidates the fingerprint', async () => {
    const storage = new InMemoryStorage();
    await writePersonality(storage, 'atlas', { name: 'Atlas' });

    const registry = new FilePersonalityRegistry(storage);
    await registry.loadFromDirectory(DIR);
    expect(registry.get('atlas')?.skillsDirs).toBeUndefined();

    // Install a skill: the `skills/` DIRECTORY is created where none existed.
    // No fingerprinted FILE changed — only the directory. Without `skills/` in
    // the fingerprint, loadOne short-circuits and `skillsDirs` stays undefined
    // until the process restarts.
    const skillsDir = join(DIR, 'atlas', 'skills');
    await storage.mkdir(skillsDir);
    await storage.write(join(skillsDir, 'charts.md'), '---\nname: charts\n---\n# Charts\n');

    await registry.loadFromDirectory(DIR);

    expect(registry.get('atlas')?.skillsDirs).toEqual([skillsDir]);
  });

  it('criterion 6 — fingerprint fast path: a no-change refresh performs no read() and no re-parse', async () => {
    const storage = new InMemoryStorage();
    await writePersonality(storage, 'atlas', { name: 'Atlas' });

    const registry = new FilePersonalityRegistry(storage);
    await registry.loadFromDirectory(DIR);
    expect(registry.get('atlas')).toBeDefined();

    // Spy AFTER the first load so we count only the second (no-change) pass.
    const readSpy = vi.spyOn(storage, 'read');
    const mtimeSpy = vi.spyOn(storage, 'mtime');

    await registry.loadFromDirectory(DIR);

    // Fast path returns before buildConfig — zero content reads on a no-change
    // refresh; only mtime/stat traffic for the fingerprint.
    expect(readSpy).not.toHaveBeenCalled();
    expect(mtimeSpy).toHaveBeenCalled();
  });
});
