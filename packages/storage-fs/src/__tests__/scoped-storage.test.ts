import { BoundaryError } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStorage } from '../in-memory-storage';
import { ScopedStorage } from '../scoped-storage';

describe('ScopedStorage', () => {
  let inner: InMemoryStorage;

  beforeEach(async () => {
    inner = new InMemoryStorage();
    await inner.mkdir('/ethos');
    await inner.mkdir('/ethos/personalities');
    await inner.mkdir('/ethos/personalities/researcher');
    await inner.mkdir('/ethos/personalities/engineer');
    await inner.mkdir('/cwd');
    await inner.write('/ethos/personalities/researcher/MEMORY.md', 'mine');
    await inner.write('/ethos/personalities/engineer/MEMORY.md', 'theirs');
  });

  it('allows reads inside the read allowlist', async () => {
    const scoped = new ScopedStorage(inner, {
      read: ['/ethos/personalities/researcher/'],
      write: ['/ethos/personalities/researcher/'],
    });
    expect(await scoped.read('/ethos/personalities/researcher/MEMORY.md')).toBe('mine');
  });

  it('blocks reads outside the read allowlist with BoundaryError', async () => {
    const scoped = new ScopedStorage(inner, {
      read: ['/ethos/personalities/researcher/'],
      write: ['/ethos/personalities/researcher/'],
    });
    await expect(scoped.read('/ethos/personalities/engineer/MEMORY.md')).rejects.toBeInstanceOf(
      BoundaryError,
    );
  });

  it('allows writes inside the write allowlist', async () => {
    const scoped = new ScopedStorage(inner, {
      read: ['/ethos/personalities/researcher/'],
      write: ['/ethos/personalities/researcher/'],
    });
    await scoped.write('/ethos/personalities/researcher/note.md', 'hello');
    expect(await inner.read('/ethos/personalities/researcher/note.md')).toBe('hello');
  });

  it('blocks writes outside the write allowlist with BoundaryError', async () => {
    const scoped = new ScopedStorage(inner, {
      read: ['/ethos/personalities/researcher/'],
      write: ['/ethos/personalities/researcher/'],
    });
    await expect(
      scoped.write('/ethos/personalities/engineer/note.md', 'hi'),
    ).rejects.toBeInstanceOf(BoundaryError);
  });

  it('write-only path is readable too only when in the read allowlist', async () => {
    const scoped = new ScopedStorage(inner, {
      read: [],
      write: ['/cwd/'],
    });
    await scoped.write('/cwd/out.txt', 'ok');
    await expect(scoped.read('/cwd/out.txt')).rejects.toBeInstanceOf(BoundaryError);
  });

  it('exists / mtime / list / listEntries respect read allowlist', async () => {
    const scoped = new ScopedStorage(inner, {
      read: ['/ethos/personalities/researcher/'],
      write: ['/ethos/personalities/researcher/'],
    });
    expect(await scoped.exists('/ethos/personalities/researcher/MEMORY.md')).toBe(true);
    await expect(scoped.exists('/ethos/personalities/engineer/MEMORY.md')).rejects.toBeInstanceOf(
      BoundaryError,
    );
    await expect(scoped.list('/ethos/personalities/engineer')).rejects.toBeInstanceOf(
      BoundaryError,
    );
    await expect(scoped.listEntries('/ethos/personalities/engineer')).rejects.toBeInstanceOf(
      BoundaryError,
    );
    await expect(scoped.mtime('/ethos/personalities/engineer/MEMORY.md')).rejects.toBeInstanceOf(
      BoundaryError,
    );
  });

  it('mkdir / remove / rename respect write allowlist', async () => {
    const scoped = new ScopedStorage(inner, {
      read: ['/ethos/personalities/researcher/'],
      write: ['/ethos/personalities/researcher/'],
    });
    await expect(scoped.mkdir('/ethos/personalities/engineer/sub')).rejects.toBeInstanceOf(
      BoundaryError,
    );
    await expect(scoped.remove('/ethos/personalities/engineer/MEMORY.md')).rejects.toBeInstanceOf(
      BoundaryError,
    );
    await expect(
      scoped.rename(
        '/ethos/personalities/researcher/MEMORY.md',
        '/ethos/personalities/engineer/MEMORY.md',
      ),
    ).rejects.toBeInstanceOf(BoundaryError);
  });

  it('matches prefix on directory boundary, not raw substring', async () => {
    // `/ethos/personalities/research/` must NOT also allow `/ethos/personalities/researcher/`
    const scoped = new ScopedStorage(inner, {
      read: ['/ethos/personalities/research/'],
      write: ['/ethos/personalities/research/'],
    });
    await expect(scoped.read('/ethos/personalities/researcher/MEMORY.md')).rejects.toBeInstanceOf(
      BoundaryError,
    );
  });

  it('accepts prefixes both with and without trailing slash', async () => {
    const scoped = new ScopedStorage(inner, {
      read: ['/ethos/personalities/researcher'],
      write: ['/ethos/personalities/researcher'],
    });
    expect(await scoped.read('/ethos/personalities/researcher/MEMORY.md')).toBe('mine');
  });

  it('BoundaryError carries kind and path for surface translation', async () => {
    const scoped = new ScopedStorage(inner, { read: [], write: [] });
    try {
      await scoped.read('/blocked');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BoundaryError);
      expect((err as BoundaryError).kind).toBe('read');
      expect((err as BoundaryError).path).toBe('/blocked');
      expect((err as BoundaryError).code).toBe('storage-boundary');
    }
  });
});
