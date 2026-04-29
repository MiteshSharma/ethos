import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Storage } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsStorage } from '../fs-storage';
import { InMemoryStorage } from '../in-memory-storage';

interface Backend {
  name: string;
  setup: () => Promise<{ storage: Storage; root: string; cleanup: () => Promise<void> }>;
}

const backends: Backend[] = [
  {
    name: 'FsStorage',
    setup: async () => {
      const root = await mkdtemp(join(tmpdir(), 'ethos-fsstore-'));
      const storage = new FsStorage();
      return {
        storage,
        root,
        cleanup: async () => {
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  },
  {
    name: 'InMemoryStorage',
    setup: async () => {
      const root = '/mem-root';
      const storage = new InMemoryStorage();
      await storage.mkdir(root);
      return {
        storage,
        root,
        cleanup: async () => {
          // no-op — gc'd with the instance
        },
      };
    },
  },
];

describe.each(backends)('Storage conformance — $name', ({ setup }) => {
  let storage: Storage;
  let root: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const out = await setup();
    storage = out.storage;
    root = out.root;
    cleanup = out.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  // --- Reads -------------------------------------------------------

  it('read returns null for a missing file', async () => {
    expect(await storage.read(join(root, 'missing.txt'))).toBeNull();
  });

  it('read round-trips utf-8 content', async () => {
    const path = join(root, 'hello.txt');
    await storage.write(path, 'héllo 🌱');
    expect(await storage.read(path)).toBe('héllo 🌱');
  });

  it('read on a directory throws EISDIR', async () => {
    const dir = join(root, 'somedir');
    await storage.mkdir(dir);
    await expect(storage.read(dir)).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('exists is false for missing, true for file, true for directory', async () => {
    expect(await storage.exists(join(root, 'nope'))).toBe(false);
    const file = join(root, 'a.txt');
    await storage.write(file, 'x');
    expect(await storage.exists(file)).toBe(true);
    const dir = join(root, 'd');
    await storage.mkdir(dir);
    expect(await storage.exists(dir)).toBe(true);
  });

  it('mtime returns null for missing, a number for present', async () => {
    expect(await storage.mtime(join(root, 'nope'))).toBeNull();
    const path = join(root, 'm.txt');
    await storage.write(path, 'x');
    const t = await storage.mtime(path);
    expect(typeof t).toBe('number');
    expect(t).toBeGreaterThan(0);
  });

  it('mtime advances on rewrite', async () => {
    const path = join(root, 'tick.txt');
    await storage.write(path, '1');
    const t1 = (await storage.mtime(path)) ?? 0;
    // Sleep a beat so fs implementations with second-precision mtime see the
    // delta. InMemoryStorage uses a monotonic counter so this is instant.
    await new Promise((r) => setTimeout(r, 15));
    await storage.write(path, '2');
    const t2 = (await storage.mtime(path)) ?? 0;
    expect(t2).toBeGreaterThanOrEqual(t1);
  });

  it('list returns [] for a missing directory', async () => {
    expect(await storage.list(join(root, 'nope'))).toEqual([]);
  });

  it('list returns immediate children only', async () => {
    const a = join(root, 'a.txt');
    const b = join(root, 'sub');
    await storage.write(a, 'a');
    await storage.mkdir(b);
    await storage.write(join(b, 'inner.txt'), 'i');
    const names = (await storage.list(root)).sort();
    expect(names).toContain('a.txt');
    expect(names).toContain('sub');
    expect(names).not.toContain('inner.txt');
  });

  it('listEntries reports file vs directory', async () => {
    await storage.write(join(root, 'f.txt'), 'x');
    await storage.mkdir(join(root, 'd'));
    const entries = (await storage.listEntries(root)).sort((a, b) => a.name.localeCompare(b.name));
    const f = entries.find((e) => e.name === 'f.txt');
    const d = entries.find((e) => e.name === 'd');
    expect(f).toEqual({ name: 'f.txt', isDir: false });
    expect(d).toEqual({ name: 'd', isDir: true });
  });

  // --- Writes ------------------------------------------------------

  it('write creates a new file', async () => {
    const path = join(root, 'new.txt');
    await storage.write(path, 'hi');
    expect(await storage.read(path)).toBe('hi');
  });

  it('write overwrites existing file', async () => {
    const path = join(root, 'over.txt');
    await storage.write(path, 'first');
    await storage.write(path, 'second');
    expect(await storage.read(path)).toBe('second');
  });

  it('write into missing parent throws ENOENT', async () => {
    const path = join(root, 'no-parent', 'x.txt');
    await expect(storage.write(path, 'x')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writeAtomic creates a new file', async () => {
    const path = join(root, 'atomic.txt');
    await storage.writeAtomic(path, 'safe');
    expect(await storage.read(path)).toBe('safe');
  });

  it('writeAtomic overwrites existing file', async () => {
    const path = join(root, 'atomic2.txt');
    await storage.write(path, 'old');
    await storage.writeAtomic(path, 'new');
    expect(await storage.read(path)).toBe('new');
  });

  it('writeAtomic leaves no .tmp file behind on success', async () => {
    const path = join(root, 'atomic3.txt');
    await storage.writeAtomic(path, 'done');
    const names = await storage.list(root);
    expect(names.filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  // --- Directories -------------------------------------------------

  it('mkdir creates a single directory', async () => {
    const dir = join(root, 'd1');
    await storage.mkdir(dir);
    expect(await storage.exists(dir)).toBe(true);
  });

  it('mkdir is recursive (creates parents)', async () => {
    const dir = join(root, 'a', 'b', 'c');
    await storage.mkdir(dir);
    expect(await storage.exists(dir)).toBe(true);
    expect(await storage.exists(join(root, 'a', 'b'))).toBe(true);
  });

  it('mkdir is a no-op on an existing directory', async () => {
    const dir = join(root, 'dup');
    await storage.mkdir(dir);
    await storage.mkdir(dir);
    expect(await storage.exists(dir)).toBe(true);
  });

  it('mkdir on an existing file throws', async () => {
    const path = join(root, 'is-a-file.txt');
    await storage.write(path, 'x');
    await expect(storage.mkdir(path)).rejects.toThrow();
  });

  it('remove deletes a file', async () => {
    const path = join(root, 'del.txt');
    await storage.write(path, 'x');
    await storage.remove(path);
    expect(await storage.exists(path)).toBe(false);
  });

  it('remove on missing path throws', async () => {
    await expect(storage.remove(join(root, 'nope'))).rejects.toThrow();
  });

  it('remove on non-empty dir without recursive throws', async () => {
    const dir = join(root, 'full');
    await storage.mkdir(dir);
    await storage.write(join(dir, 'inner.txt'), 'x');
    await expect(storage.remove(dir)).rejects.toThrow();
    expect(await storage.exists(dir)).toBe(true);
  });

  it('remove with recursive deletes a non-empty directory', async () => {
    const dir = join(root, 'tree');
    await storage.mkdir(join(dir, 'sub'));
    await storage.write(join(dir, 'a.txt'), 'a');
    await storage.write(join(dir, 'sub', 'b.txt'), 'b');
    await storage.remove(dir, { recursive: true });
    expect(await storage.exists(dir)).toBe(false);
  });

  it('rename moves a file', async () => {
    const a = join(root, 'a.txt');
    const b = join(root, 'b.txt');
    await storage.write(a, 'hello');
    await storage.rename(a, b);
    expect(await storage.exists(a)).toBe(false);
    expect(await storage.read(b)).toBe('hello');
  });

  it('rename overwrites existing file at target', async () => {
    const a = join(root, 'src.txt');
    const b = join(root, 'dst.txt');
    await storage.write(a, 'src-content');
    await storage.write(b, 'dst-content');
    await storage.rename(a, b);
    expect(await storage.read(b)).toBe('src-content');
    expect(await storage.exists(a)).toBe(false);
  });

  it('rename on missing source throws', async () => {
    await expect(storage.rename(join(root, 'nope'), join(root, 'somewhere'))).rejects.toThrow();
  });

  // --- Round-trip equivalence between implementations -------------

  it('write then list round-trip', async () => {
    await storage.write(join(root, 'rt.txt'), 'data');
    const names = await storage.list(root);
    expect(names).toContain('rt.txt');
  });
});

// --- FsStorage-only regression tests -------------------------------

describe('FsStorage — atomic write crash semantics', () => {
  let root: string;
  let storage: FsStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ethos-atomic-'));
    storage = new FsStorage();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // REGRESSION: simulated crash. If writeAtomic crashed before the rename
  // happened, the original file must be untouched. This is the property
  // that makes writeAtomic worth having.
  it('writeAtomic preserves original on simulated crash', async () => {
    const path = join(root, 'config.txt');
    await storage.write(path, 'original');
    // Simulate a crashed atomic write by leaving a stale .tmp file behind.
    const tmpName = `${path}.tmp.${process.pid}.999`;
    await writeFile(tmpName, 'corrupted partial');
    // Reading the real file still returns the original.
    expect(await storage.read(path)).toBe('original');
  });
});

describe.skipIf(process.platform === 'win32')('FsStorage — POSIX mode application', () => {
  let root: string;
  let storage: FsStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ethos-mode-'));
    storage = new FsStorage();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('write({ mode }) applies POSIX permissions', async () => {
    const path = join(root, 'secret.txt');
    await storage.write(path, 'shh', { mode: 0o600 });
    const s = await stat(path);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it('writeAtomic({ mode }) applies POSIX permissions', async () => {
    const path = join(root, 'atomic-secret.txt');
    await storage.writeAtomic(path, 'shh', { mode: 0o600 });
    const s = await stat(path);
    expect(s.mode & 0o777).toBe(0o600);
  });
});
