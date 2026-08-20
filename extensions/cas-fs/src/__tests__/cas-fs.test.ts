import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FsContentStore } from '../index';

const ROOT = '/ethos/cas';

describe('FsContentStore', () => {
  let storage: InMemoryStorage;
  let store: FsContentStore;

  beforeEach(() => {
    storage = new InMemoryStorage();
    store = new FsContentStore(ROOT, storage);
  });

  it('round-trips content through put/get', async () => {
    const hash = await store.put('hello world');
    expect(await store.get(hash)).toBe('hello world');
  });

  it('has() is true after put and false for an unknown hash', async () => {
    const hash = await store.put('some content');
    expect(await store.has(hash)).toBe(true);

    const unrelated = store.hash('never stored');
    expect(await store.has(unrelated)).toBe(false);
  });

  it('hash() is pure — same input yields the same hash, no I/O', async () => {
    const content = 'stable content';
    const h1 = store.hash(content);
    const h2 = store.hash(content);
    expect(h1).toBe(h2);

    // Calling hash() alone must not write anything.
    expect(await store.has(h1)).toBe(false);
    expect(await storage.list(ROOT)).toEqual([]);
  });

  it('put() is idempotent — repeated puts of identical content write once', async () => {
    const writeAtomicSpy = vi.spyOn(storage, 'writeAtomic');

    const h1 = await store.put('duplicate content');
    const h2 = await store.put('duplicate content');

    expect(h1).toBe(h2);
    expect(writeAtomicSpy).toHaveBeenCalledTimes(1);

    const shardDir = join(ROOT, h1.slice(0, 2));
    expect(await storage.list(shardDir)).toEqual([h1.slice(2)]);
  });

  it('get() returns null for an unknown but validly-shaped hash', async () => {
    const unknown = store.hash('nothing put here');
    expect(await store.get(unknown)).toBeNull();
  });

  it('get() and has() return null/false (never throw) for malformed hashes', async () => {
    const malformed = [
      'short',
      'a'.repeat(64).toUpperCase(),
      '../../etc/passwd',
      `${'g'.repeat(64)}`, // non-hex characters
      `../${'a'.repeat(62)}`,
    ];

    for (const bad of malformed) {
      await expect(store.get(bad)).resolves.toBeNull();
      await expect(store.has(bad)).resolves.toBe(false);
    }
  });

  it('deduplicates identical content across separate callers into one blob', async () => {
    const h1 = await store.put('shared content');
    const h2 = await store.put('shared content');

    expect(h1).toBe(h2);
    const shardDir = join(ROOT, h1.slice(0, 2));
    expect(await storage.list(shardDir)).toHaveLength(1);
  });

  it('identical content across two different sessions produces one CAS blob (acceptance criterion 8)', async () => {
    // ContentStore.put() has no sessionId parameter — content-addressing is
    // inherently session-agnostic, so this is two independent put() calls
    // made from what would be two different session contexts in a real
    // caller (e.g. two sessions bound to the same stable personality).
    const sessionAContent = 'shared personality body, read by session A';
    const sessionBContent = sessionAContent; // session B observes the SAME bytes

    const hashFromSessionA = await store.put(sessionAContent);
    const hashFromSessionB = await store.put(sessionBContent);

    expect(hashFromSessionA).toBe(hashFromSessionB);
    const shardDir = join(ROOT, hashFromSessionA.slice(0, 2));
    expect(await storage.list(shardDir)).toEqual([hashFromSessionA.slice(2)]);
  });
});
