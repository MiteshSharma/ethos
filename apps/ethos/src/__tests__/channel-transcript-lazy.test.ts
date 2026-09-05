// `openChannelTranscriptStore` — the observe-mode transcript sink, opened on
// first write.
//
// `new SQLiteChannelTranscriptStore(path)` creates the file and runs its
// migration in the constructor. Both `ethos gateway` and `ethos boot`
// construct the sink unconditionally at startup (they cannot know whether any
// chat is set to observe — the modes live in per-bot override files the
// adapters read later), so an eager store would drop a `channel-transcript.db`
// into every deployment's `~/.ethos/`, including the ones that never record a
// thing. The file existing should mean something is being watched.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcriptLaneKey } from '@ethosagent/channel-transcript-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openChannelTranscriptStore } from '../commands/gateway';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ethos-transcript-'));
  dbPath = join(dir, 'channel-transcript.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('openChannelTranscriptStore', () => {
  it('creates no database file until something is actually recorded', () => {
    const store = openChannelTranscriptStore(dbPath);

    expect(existsSync(dbPath)).toBe(false);

    // Closing an unopened sink is a no-op, not a crash — every gateway
    // shutdown runs through this on a machine that observed nothing.
    store.close();
    expect(existsSync(dbPath)).toBe(false);
  });

  // The digest reads before anything has ever been written on most machines.
  // If a read opened the store, enabling the digest would create and migrate
  // `channel-transcript.db` on a deployment that has observed nothing — the
  // same file appearing for the same wrong reason, one caller later.
  it('creates no database file when the digest reads a house that observed nothing', async () => {
    const store = openChannelTranscriptStore(dbPath);

    await expect(store.listLanes()).resolves.toEqual([]);
    await expect(store.readSince('discord:bot-1:C_SITE_7', 0)).resolves.toEqual({
      messages: [],
      omittedCount: 0,
    });

    expect(existsSync(dbPath)).toBe(false);
    store.close();
    expect(existsSync(dbPath)).toBe(false);
  });

  it('reads through a database another process already created', async () => {
    const writer = openChannelTranscriptStore(dbPath);
    await writer.record({
      platform: 'discord',
      botKey: 'bot-1',
      chatId: 'C_SITE_7',
      senderId: 'U_STRANGER',
      text: 'gate code changed',
      sentAt: 1_700_000_000_000,
      recordedAt: 1_700_000_000_000,
    });
    writer.close();

    // A fresh handle that has never written: the file exists, so reads open it.
    const reader = openChannelTranscriptStore(dbPath);
    const lanes = await reader.listLanes();
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.chatId).toBe('C_SITE_7');
    reader.close();
  });

  it('opens on the first write and keeps the rows', async () => {
    const store = openChannelTranscriptStore(dbPath);

    await store.record({
      platform: 'discord',
      botKey: 'bot-1',
      chatId: 'C_SITE_7',
      senderId: 'U_STRANGER',
      text: 'concrete pour slipped to thursday',
      messageId: 'm-1',
      sentAt: 1_700_000_000_000,
      recordedAt: 1_700_000_000_500,
    });

    expect(existsSync(dbPath)).toBe(true);

    const lanes = await store.listLanes();
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.chatId).toBe('C_SITE_7');
    store.close();
  });

  it('reuses the one connection across writes rather than reopening per call', async () => {
    const store = openChannelTranscriptStore(dbPath);
    const entry = {
      platform: 'discord',
      botKey: 'bot-1',
      chatId: 'C_SITE_7',
      senderId: 'U_STRANGER',
      text: 'first',
      sentAt: 1_700_000_000_000,
      recordedAt: 1_700_000_000_000,
    };

    await store.record(entry);
    await store.record({ ...entry, text: 'second', sentAt: 1_700_000_001_000 });

    const page = await store.readSince(transcriptLaneKey('discord', 'bot-1', 'C_SITE_7'), 0);
    expect(page.messages.map((m) => m.text)).toEqual(['first', 'second']);
    store.close();
  });
});
