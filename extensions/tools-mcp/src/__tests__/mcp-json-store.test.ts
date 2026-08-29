// Tests for McpJsonStore — the shared `mcp.json` writer that the CLI and the
// SDK install flow both use. Concurrent CLI + UI use should serialize through
// the same atomic-write path.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerConfig } from '../index';
import { McpJsonStore } from '../mcp-json-store';

const PATH = '/home/test/.ethos/mcp.json';
const DIR = '/home/test/.ethos';

function makeEntry(name: string, command = 'node'): McpServerConfig {
  return { name, transport: 'stdio', command };
}

async function freshStorage(): Promise<InMemoryStorage> {
  const s = new InMemoryStorage();
  await s.mkdir(DIR);
  return s;
}

describe('McpJsonStore', () => {
  let storage: InMemoryStorage;
  let store: McpJsonStore;

  beforeEach(async () => {
    storage = await freshStorage();
    store = new McpJsonStore(storage, PATH);
  });

  it('list() returns [] for a missing file', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('list() returns [] for invalid JSON', async () => {
    await storage.writeAtomic(PATH, 'not json');
    expect(await store.list()).toEqual([]);
  });

  it('list() returns [] for a non-array root', async () => {
    await storage.writeAtomic(PATH, JSON.stringify({ name: 'oops' }));
    expect(await store.list()).toEqual([]);
  });

  it('upsert + list round-trip', async () => {
    const a = makeEntry('a');
    const b = makeEntry('b');
    await store.upsert(a.name, a);
    await store.upsert(b.name, b);
    const all = await store.list();
    expect(all).toEqual([a, b]);
  });

  it('writes mcp.json owner-only (headers / env are credential-adjacent)', async () => {
    await store.upsert('a', makeEntry('a'));
    expect(storage.getMode(PATH)).toBe(0o600);
  });

  it('get() returns one entry by name', async () => {
    const a = makeEntry('a');
    await store.upsert(a.name, a);
    expect(await store.get('a')).toEqual(a);
    expect(await store.get('missing')).toBeNull();
  });

  it('upsert replaces an existing entry by name', async () => {
    await store.upsert('a', makeEntry('a', 'old'));
    await store.upsert('a', makeEntry('a', 'new'));
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.command).toBe('new');
  });

  it('remove() drops an entry', async () => {
    await store.upsert('a', makeEntry('a'));
    await store.upsert('b', makeEntry('b'));
    await store.remove('a');
    const all = await store.list();
    expect(all.map((e) => e.name)).toEqual(['b']);
  });

  it('remove() is a no-op if absent', async () => {
    await store.upsert('a', makeEntry('a'));
    await store.remove('missing');
    const all = await store.list();
    expect(all.map((e) => e.name)).toEqual(['a']);
  });

  it('writes valid JSON the loader will accept', async () => {
    await store.upsert('a', makeEntry('a'));
    const raw = await storage.read(PATH);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? '');
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].name).toBe('a');
    expect(raw?.endsWith('\n')).toBe(true);
  });

  it('serializes concurrent upserts so no write is lost', async () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    await Promise.all(names.map((n) => store.upsert(n, makeEntry(n))));
    const all = await store.list();
    expect(all.map((e) => e.name).sort()).toEqual([...names].sort());
  });

  it('atomic write — a failed writeAtomic leaves the file unchanged', async () => {
    await store.upsert('a', makeEntry('a'));
    const before = await storage.read(PATH);

    const spy = vi.spyOn(storage, 'writeAtomic').mockRejectedValueOnce(new Error('disk full'));
    await expect(store.upsert('b', makeEntry('b'))).rejects.toThrow('disk full');
    spy.mockRestore();

    const after = await storage.read(PATH);
    expect(after).toBe(before);
    // And subsequent operations still work — the mutex didn't latch in a poisoned state.
    await store.upsert('c', makeEntry('c'));
    const all = await store.list();
    expect(all.map((e) => e.name).sort()).toEqual(['a', 'c']);
  });
});
