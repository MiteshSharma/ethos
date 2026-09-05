import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SQLiteChannelTranscriptStore,
  transcriptLanePrefix,
} from '@ethosagent/channel-transcript-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type { ChannelTranscriptStore } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObservedChatsService } from '../../services/observed-chats.service';

// A real transcript file, not an in-memory one: "has the gateway ever observed
// anything here" is half of what this service decides, and `:memory:` cannot
// express it.

describe('ObservedChatsService', () => {
  let dir: string;
  const storage = new FsStorage();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ethos-observed-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(store: SQLiteChannelTranscriptStore, entry: Partial<{ [k: string]: unknown }>) {
    return store.record({
      platform: 'telegram',
      botKey: 'bot-a',
      chatId: '-100',
      senderId: 'u1',
      text: 'hello',
      sentAt: 1_000,
      recordedAt: 1_000,
      ...entry,
    } as Parameters<SQLiteChannelTranscriptStore['record']>[0]);
  }

  it('reports an empty house — and creates NO database — when nothing was ever observed', async () => {
    const service = new ObservedChatsService({ dataDir: dir, storage });
    expect(await service.observed()).toEqual({ lanes: [], omittedCount: 0, error: null });
    // The read must not have written: `new SQLiteChannelTranscriptStore` mkdirs
    // and migrates a file this deployment has no use for.
    expect(await storage.exists(join(dir, 'channel-transcript.db'))).toBe(false);
  });

  it('lists every watched lane with the summary the store actually returns', async () => {
    const store = new SQLiteChannelTranscriptStore(join(dir, 'channel-transcript.db'));
    await write(store, { chatId: '-100', messageId: 'm1', sentAt: 5_000 });
    await write(store, { chatId: '-100', messageId: 'm2', sentAt: 6_000 });
    await write(store, { chatId: '-200', messageId: 'm3', sentAt: 9_000, threadId: 't7' });
    store.close();

    const service = new ObservedChatsService({ dataDir: dir, storage });
    const result = await service.observed();

    expect(result.error).toBeNull();
    expect(result.omittedCount).toBe(0);
    // Newest-active first.
    expect(result.lanes.map((l) => l.chatId)).toEqual(['-200', '-100']);
    const [thread, root] = result.lanes;
    expect(thread).toMatchObject({
      platform: 'telegram',
      botKey: 'bot-a',
      chatId: '-200',
      threadId: 't7',
      count: 1,
      lastSentAt: 9_000,
    });
    // A root-chat lane carries a NULL thread, never `''` or the string 'null'.
    expect(root?.threadId).toBeNull();
    expect(root).toMatchObject({ count: 2, lastSentAt: 6_000 });
    expect(root?.laneKey.startsWith(transcriptLanePrefix('telegram', 'bot-a'))).toBe(true);
  });

  it('windows `count` by `since` while keeping the quiet lane listed', async () => {
    const store = new SQLiteChannelTranscriptStore(join(dir, 'channel-transcript.db'));
    await write(store, { chatId: 'busy', messageId: 'a', sentAt: 10_000 });
    await write(store, { chatId: 'quiet', messageId: 'b', sentAt: 1_000 });
    store.close();

    const service = new ObservedChatsService({ dataDir: dir, storage });
    const result = await service.observed({ since: 5_000 });

    // The quiet room is still a watched room. Zero is a real answer.
    expect(result.lanes.map((l) => [l.chatId, l.count])).toEqual([
      ['busy', 1],
      ['quiet', 0],
    ]);
  });

  it('surfaces `omittedCount` instead of truncating in silence', async () => {
    const store = new SQLiteChannelTranscriptStore(join(dir, 'channel-transcript.db'));
    for (let i = 0; i < 5; i++) {
      await write(store, { chatId: `c${i}`, messageId: `m${i}`, sentAt: 1_000 + i });
    }
    store.close();

    const service = new ObservedChatsService({ dataDir: dir, storage });
    const result = await service.observed({ limit: 2 });

    expect(result.lanes).toHaveLength(2);
    expect(result.omittedCount).toBe(3);
    // The head is the FRESHEST — a list that must drop something drops the
    // stale end, exactly as `readSince` does with messages.
    expect(result.lanes.map((l) => l.chatId)).toEqual(['c4', 'c3']);
  });

  it('turns an unreadable transcript into an error field, NOT a throw', async () => {
    const store = new SQLiteChannelTranscriptStore(join(dir, 'channel-transcript.db'));
    store.close();

    const broken: ChannelTranscriptStore = {
      record: async () => {},
      readSince: async () => ({ messages: [], omittedCount: 0 }),
      listLanes: async () => {
        throw new Error('database disk image is malformed');
      },
      close: () => {},
    };
    const service = new ObservedChatsService({
      dataDir: dir,
      storage,
      openStore: () => broken,
    });

    // A rejected RPC would reach the client as an exception it renders as a
    // toast that leaves. The contract wants a `✗ failed` row that stays, so
    // the failure has to arrive as DATA.
    const result = await service.observed();
    expect(result.error).toBe('database disk image is malformed');
    expect(result.lanes).toEqual([]);
    expect(result.omittedCount).toBe(0);
  });
});
