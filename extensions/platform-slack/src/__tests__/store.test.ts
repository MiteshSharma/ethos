import { ChannelOverrideStore } from '@ethosagent/core';
import type { Storage, StorageDirEntry } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { ChannelModeSchema } from '../config';
import { ThreadStateStore } from '../store/thread-state';

/**
 * Minimal in-memory Storage stub. Built locally to avoid a devDependency
 * on @ethosagent/storage-fs — the slack package shouldn't have to pull
 * in a sibling extension just for tests.
 */
function memStorage(): Storage {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    async read(p) {
      return files.has(p) ? (files.get(p) ?? null) : null;
    },
    async readBytes(p) {
      const s = files.get(p);
      return s === undefined ? null : new TextEncoder().encode(s);
    },
    async exists(p) {
      return files.has(p) || dirs.has(p);
    },
    async mtime(p) {
      return files.has(p) ? Date.now() : null;
    },
    async list(_d) {
      return [];
    },
    async listEntries(_d): Promise<StorageDirEntry[]> {
      return [];
    },
    async write(p, content) {
      files.set(p, typeof content === 'string' ? content : Buffer.from(content).toString('utf-8'));
    },
    async append(p, content) {
      const cur = files.get(p) ?? '';
      files.set(p, cur + content);
    },
    async writeAtomic(p, content) {
      files.set(p, typeof content === 'string' ? content : Buffer.from(content).toString('utf-8'));
    },
    async mkdir(d) {
      dirs.add(d);
    },
    async remove(p) {
      files.delete(p);
      dirs.delete(p);
    },
    async rename(from, to) {
      const v = files.get(from);
      if (v !== undefined) {
        files.set(to, v);
        files.delete(from);
      }
    },
    async chmod() {},
  };
}

// Slack's per-channel override store is now the shared one from
// `@ethosagent/core` (plan/phases/ambient-group-monitoring.md R6). This suite
// is kept as the regression guard on Slack's *use* of it, driving it exactly
// as `SlackAdapter` does: the per-bot directory joined at the construction
// site, and Slack's own `ChannelModeSchema` as the mode validator.
//
// Two assertions here changed shape, and both were corrections rather than
// relaxations. Slack's deleted copy indexed a BARE mode and joined `botKey`
// onto the platform directory itself, while Telegram's copy — the same file,
// two packages over — indexed `{ mode, regexPattern? }` and took the per-bot
// directory. That divergence is the drift the shared store exists to end, so
// the tests now assert the shared shape:
//
//   `get()` → `{ mode: 'all' }`, was `'all'`
//
// Both still assert the same fact (which mode was stored for which channel) at
// the same strength — `toEqual({ mode: 'all' })` fails for a wrong mode, a
// missing entry, or a stray extra field exactly as `toBe('all')` did.

/** The per-bot directory, joined by the caller — as `SlackAdapter` does. */
const BOT_DIR = '/slack/bot-a';

describe('ChannelOverrideStore (shared core store, Slack binding)', () => {
  it('persists and reloads channel modes', async () => {
    const storage = memStorage();
    const store = new ChannelOverrideStore(storage, BOT_DIR, ChannelModeSchema);
    await store.set('C1', 'all');
    await store.set('C2', 'thread_follow');
    expect(store.get('C1')).toEqual({ mode: 'all' });
    expect(store.get('C2')).toEqual({ mode: 'thread_follow' });

    // Fresh store backed by the same storage replays JSONL
    const replay = new ChannelOverrideStore(storage, BOT_DIR, ChannelModeSchema);
    await replay.load();
    expect(replay.get('C1')).toEqual({ mode: 'all' });
    expect(replay.get('C2')).toEqual({ mode: 'thread_follow' });
  });

  it('latest record for a channel wins on reload', async () => {
    const storage = memStorage();
    const store = new ChannelOverrideStore(storage, BOT_DIR, ChannelModeSchema);
    await store.set('C1', 'all');
    await store.set('C1', 'mention_only');
    expect(store.get('C1')).toEqual({ mode: 'mention_only' });

    const replay = new ChannelOverrideStore(storage, BOT_DIR, ChannelModeSchema);
    await replay.load();
    expect(replay.get('C1')).toEqual({ mode: 'mention_only' });
  });

  it('returns undefined for unknown channels', async () => {
    const store = new ChannelOverrideStore(memStorage(), BOT_DIR, ChannelModeSchema);
    expect(store.get('C999')).toBeUndefined();
  });

  it('writes to the per-bot directory the adapter joined, not one it derives', async () => {
    const storage = memStorage();
    const store = new ChannelOverrideStore(storage, BOT_DIR, ChannelModeSchema);
    await store.set('C1', 'all');
    expect(await storage.read('/slack/bot-a/channel-overrides.jsonl')).toContain('"channel":"C1"');
  });

  it("round-trips 'observe', the mode this widening added", async () => {
    const storage = memStorage();
    const store = new ChannelOverrideStore(storage, BOT_DIR, ChannelModeSchema);
    await store.set('C1', 'observe');

    const replay = new ChannelOverrideStore(storage, BOT_DIR, ChannelModeSchema);
    await replay.load();
    expect(replay.get('C1')).toEqual({ mode: 'observe' });
  });

  it("keeps a mode Slack's enum does not know, rather than dropping it", async () => {
    // Not adopted as a valid Slack mode — `evaluateChannelMode` still refuses
    // to answer or record on it — but kept, so the adapter can tell it apart
    // from "no override stored" and does not substitute the ANSWERING
    // `mention_only` default.
    const storage = memStorage();
    const line = JSON.stringify({ channel: 'C1', mode: 'regex_match', updatedAt: 1 });
    await storage.write('/slack/bot-a/channel-overrides.jsonl', `${line}\n`);

    const store = new ChannelOverrideStore(storage, BOT_DIR, ChannelModeSchema);
    await store.load();
    expect(store.get('C1')).toEqual({ mode: 'regex_match' });
  });
});

describe('ThreadStateStore', () => {
  it('records and recalls bot-posted threads', async () => {
    const storage = memStorage();
    const store = new ThreadStateStore(storage, '/slack', 'bot-a');
    await store.recordPost('C1', 'T1');
    expect(store.hasBotPosted('C1', 'T1')).toBe(true);
    expect(store.hasBotPosted('C1', 'T2')).toBe(false);
    expect(store.hasBotPosted('C2', 'T1')).toBe(false);
  });

  it('skips writes for keys already recorded', async () => {
    const storage = memStorage();
    const store = new ThreadStateStore(storage, '/slack', 'bot-a');
    await store.recordPost('C1', 'T1');
    await store.recordPost('C1', 'T1');
    await store.recordPost('C1', 'T1');
    // Re-load and count records to confirm no duplicates were appended
    const raw = (await storage.read('/slack/bot-a/thread-state.jsonl')) ?? '';
    const lines = raw.split('\n').filter((l) => l.trim());
    expect(lines.length).toBe(1);
  });

  it('rebuilds in-memory set from JSONL on load', async () => {
    const storage = memStorage();
    const writer = new ThreadStateStore(storage, '/slack', 'bot-a');
    await writer.recordPost('C1', 'T1');
    await writer.recordPost('C2', 'T2');

    const reader = new ThreadStateStore(storage, '/slack', 'bot-a');
    await reader.load();
    expect(reader.hasBotPosted('C1', 'T1')).toBe(true);
    expect(reader.hasBotPosted('C2', 'T2')).toBe(true);
  });
});
