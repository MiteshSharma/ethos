import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import Database from '@ethosagent/sqlite';
import type { ChannelTranscriptRecord } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteChannelTranscriptStore, transcriptLaneKey, transcriptLanePrefix } from '../index';
import { pruneChannelTranscript } from '../retention';

const T0 = 1_700_000_000_000;

function entry(over: Partial<ChannelTranscriptRecord> = {}): ChannelTranscriptRecord {
  return {
    platform: 'telegram',
    botKey: 'bot-a',
    chatId: '-100123',
    senderId: 'u1',
    senderName: 'Ada',
    text: 'hello',
    sentAt: T0,
    recordedAt: T0,
    ...over,
  };
}

describe('SQLiteChannelTranscriptStore', () => {
  let dir: string;
  let dbPath: string;
  let store: SQLiteChannelTranscriptStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'channel-transcript-'));
    dbPath = join(dir, 'nested', 'channel-transcript.db');
    store = new SQLiteChannelTranscriptStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const lane = transcriptLaneKey('telegram', 'bot-a', '-100123');

  it('creates the database directory it was pointed at', () => {
    expect(existsSync(dbPath)).toBe(true);
  });

  it('records a message and reads it back oldest-first', async () => {
    await store.record(entry({ messageId: 'm1', text: 'first', sentAt: T0 }));
    await store.record(entry({ messageId: 'm2', text: 'second', sentAt: T0 + 1000 }));

    const page = await store.readSince(lane, 0);
    expect(page.messages.map((m) => m.text)).toEqual(['first', 'second']);
    expect(page.omittedCount).toBe(0);
    expect(page.messages[0]?.senderName).toBe('Ada');
    expect(page.messages[0]?.laneKey).toBe(lane);
  });

  it('reads back absent optional fields as undefined, not null', async () => {
    await store.record(entry({ senderName: undefined, messageId: undefined, threadId: undefined }));
    const [msg] = (await store.readSince(lane, 0)).messages;
    expect(msg?.senderName).toBeUndefined();
    expect(msg?.messageId).toBeUndefined();
  });

  it('upserts on (laneKey, messageId) so an edit replaces its row', async () => {
    await store.record(entry({ messageId: 'm1', text: 'typo', sentAt: T0 }));
    await store.record(
      entry({ messageId: 'm1', text: 'fixed', sentAt: T0 + 5, recordedAt: T0 + 5 }),
    );

    const page = await store.readSince(lane, 0);
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]?.text).toBe('fixed');
    expect(page.messages[0]?.sentAt).toBe(T0 + 5);
    expect(page.messages[0]?.recordedAt).toBe(T0 + 5);
  });

  it('keeps the same messageId in two lanes apart', async () => {
    await store.record(entry({ messageId: 'm1', text: 'in A' }));
    await store.record(entry({ messageId: 'm1', chatId: '-100999', text: 'in B' }));

    expect((await store.readSince(lane, 0)).messages).toHaveLength(1);
    const otherLane = transcriptLaneKey('telegram', 'bot-a', '-100999');
    expect((await store.readSince(otherLane, 0)).messages[0]?.text).toBe('in B');
  });

  it('inserts rows without a messageId plainly instead of collapsing them', async () => {
    await store.record(entry({ text: 'one' }));
    await store.record(entry({ text: 'two' }));
    await store.record(entry({ text: 'three' }));

    const page = await store.readSince(lane, 0);
    expect(page.messages.map((m) => m.text)).toEqual(['one', 'two', 'three']);
  });

  it('treats a thread as its own lane', async () => {
    await store.record(entry({ text: 'root', messageId: 'm1' }));
    await store.record(entry({ text: 'in thread', messageId: 'm2', threadId: 't7' }));

    expect((await store.readSince(lane, 0)).messages.map((m) => m.text)).toEqual(['root']);
    const threadLane = transcriptLaneKey('telegram', 'bot-a', '-100123', 't7');
    expect((await store.readSince(threadLane, 0)).messages.map((m) => m.text)).toEqual([
      'in thread',
    ]);
  });

  it('redacts secrets in the text on the way in', async () => {
    await store.record(
      entry({ text: 'deploy key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
    );
    const [msg] = (await store.readSince(lane, 0)).messages;
    expect(msg?.text).not.toContain('sk-ant-api03-AAAA');
    expect(msg?.text).toContain('[REDACTED');
  });

  it('leaves ordinary chat text — names and numbers — alone', async () => {
    await store.record(entry({ text: 'Ada said the crane arrives at 0700' }));
    const [msg] = (await store.readSince(lane, 0)).messages;
    expect(msg?.text).toBe('Ada said the crane arrives at 0700');
  });

  describe('readSince', () => {
    // THE POINT OF THIS READ. `sent_at` is chosen by the sender and arrives out
    // of order; `id` is the order this store accepted rows. A consumer that
    // cursors on the former skips whatever shows up late, which is exactly the
    // digest bug this signature exists to close.
    it('reads in ingestion order, not in sent order', async () => {
      await store.record(entry({ messageId: 'first-seen', text: 'seen first', sentAt: T0 + 5000 }));
      await store.record(
        entry({ messageId: 'late', text: 'sent days earlier', sentAt: T0 - 5000 }),
      );

      const page = await store.readSince(lane, 0);
      expect(page.messages.map((m) => m.text)).toEqual(['seen first', 'sent days earlier']);
      // Ascending ids, which is what makes the last one a usable cursor.
      const ids = page.messages.map((m) => m.id);
      expect(ids[0]).toBeLessThan(ids[1] ?? 0);
    });

    it('reads only what was ingested after the cursor', async () => {
      await store.record(entry({ messageId: 'a', text: 'a' }));
      await store.record(entry({ messageId: 'b', text: 'b' }));
      const cursor = (await store.readSince(lane, 0)).messages[1]?.id ?? 0;
      await store.record(entry({ messageId: 'c', text: 'c' }));

      const page = await store.readSince(lane, cursor);
      expect(page.messages.map((m) => m.text)).toEqual(['c']);
      expect(page.omittedCount).toBe(0);
    });

    it('reads nothing once the cursor is past every row', async () => {
      await store.record(entry({ messageId: 'a', text: 'a' }));
      const all = await store.readSince(lane, 0);
      const cursor = all.messages[0]?.id ?? 0;

      const page = await store.readSince(lane, cursor);
      expect(page.messages).toEqual([]);
      expect(page.omittedCount).toBe(0);
    });

    it('an edit does not move a row back past a cursor that consumed it', async () => {
      // The upsert rewrites the row in place, so its `id` is unchanged: a
      // message already digested stays digested. Stated in the contract.
      await store.record(entry({ messageId: 'm1', text: 'original' }));
      const before = (await store.readSince(lane, 0)).messages[0];
      const cursor = before?.id ?? 0;

      await store.record(entry({ messageId: 'm1', text: 'edited', sentAt: T0 + 99 }));

      const page = await store.readSince(lane, cursor);
      expect(page.messages).toEqual([]);
      expect((await store.readSince(lane, 0)).messages[0]).toMatchObject({
        id: cursor,
        text: 'edited',
      });
    });

    it('keeps the FIRST INGESTED limit messages and reports the later ones as backlog', async () => {
      // Oldest-first, because the caller advances a cursor to the greatest id
      // it was handed. The newest `limit` would strand msg-0..msg-6 below that
      // cursor and consume them unread; taking the oldest leaves them above it,
      // so `omittedCount` is what the next read starts from.
      for (let i = 0; i < 10; i++) {
        await store.record(entry({ messageId: `m${i}`, text: `msg-${i}`, sentAt: T0 + i }));
      }
      const page = await store.readSince(lane, 0, { limit: 3 });
      expect(page.messages.map((m) => m.text)).toEqual(['msg-0', 'msg-1', 'msg-2']);
      expect(page.omittedCount).toBe(7);
    });

    it('drains a lane across capped reads without skipping or repeating a row', async () => {
      for (let i = 0; i < 10; i++) {
        await store.record(entry({ messageId: `m${i}`, text: `msg-${i}`, sentAt: T0 + i }));
      }
      const drained: string[] = [];
      let cursor = 0;
      for (let step = 0; step < 4; step++) {
        const page = await store.readSince(lane, cursor, { limit: 3 });
        drained.push(...page.messages.map((m) => m.text));
        cursor = page.messages.reduce((max, m) => (m.id > max ? m.id : max), cursor);
      }
      expect(drained).toEqual(Array.from({ length: 10 }, (_, i) => `msg-${i}`));
      expect((await store.readSince(lane, cursor)).messages).toEqual([]);
    });

    it('counts omissions against what is past the cursor, not the whole lane', async () => {
      for (let i = 0; i < 10; i++) {
        await store.record(entry({ messageId: `m${i}`, text: `msg-${i}`, sentAt: T0 + i }));
      }
      // Cursor at msg-4 leaves msg-5..msg-9 unconsumed (5 rows); a limit of 2
      // omits 3 of them, and every row it counts is one nobody has digested.
      const cursor = (await store.readSince(lane, 0)).messages[4]?.id ?? 0;
      const page = await store.readSince(lane, cursor, { limit: 2 });
      expect(page.messages.map((m) => m.text)).toEqual(['msg-5', 'msg-6']);
      expect(page.omittedCount).toBe(3);
    });

    it('defaults to a 500-message page', async () => {
      for (let i = 0; i < 505; i++) {
        await store.record(entry({ messageId: `m${i}`, text: `msg-${i}`, sentAt: T0 + i }));
      }
      const page = await store.readSince(lane, 0);
      expect(page.messages).toHaveLength(500);
      expect(page.omittedCount).toBe(5);
      expect(page.messages[0]?.text).toBe('msg-0');
      expect(page.messages[499]?.text).toBe('msg-499');
    });

    it('orders messages sharing a sent_at by insertion, not arbitrarily', async () => {
      for (let i = 0; i < 6; i++) {
        await store.record(entry({ messageId: `m${i}`, text: `msg-${i}`, sentAt: T0 }));
      }
      const page = await store.readSince(lane, 0);
      expect(page.messages.map((m) => m.text)).toEqual([
        'msg-0',
        'msg-1',
        'msg-2',
        'msg-3',
        'msg-4',
        'msg-5',
      ]);
      // …and the cap keeps the first-inserted ones, leaving the rest queued.
      const capped = await store.readSince(lane, 0, { limit: 2 });
      expect(capped.messages.map((m) => m.text)).toEqual(['msg-0', 'msg-1']);
    });

    it('returns an empty page for a lane it has never seen', async () => {
      const page = await store.readSince('slack:nobody:C1', 0);
      expect(page.messages).toEqual([]);
      expect(page.omittedCount).toBe(0);
    });
  });

  describe('listLanes', () => {
    it('summarises each lane, newest-active first', async () => {
      await store.record(entry({ messageId: 'a1', chatId: '-1', sentAt: T0 }));
      await store.record(entry({ messageId: 'a2', chatId: '-1', sentAt: T0 + 10 }));
      await store.record(entry({ messageId: 'b1', chatId: '-2', sentAt: T0 + 50 }));

      const lanes = await store.listLanes();
      expect(lanes).toHaveLength(2);
      expect(lanes[0]).toMatchObject({
        laneKey: transcriptLaneKey('telegram', 'bot-a', '-2'),
        platform: 'telegram',
        botKey: 'bot-a',
        chatId: '-2',
        count: 1,
        lastSentAt: T0 + 50,
      });
      expect(lanes[0]?.threadId).toBeUndefined();
      expect(lanes[1]).toMatchObject({ chatId: '-1', count: 2, lastSentAt: T0 + 10 });
    });

    it('windows count by since but still lists a lane that was quiet', async () => {
      await store.record(entry({ messageId: 'old', chatId: '-1', sentAt: T0 }));
      await store.record(entry({ messageId: 'new', chatId: '-2', sentAt: T0 + 100 }));

      const lanes = await store.listLanes({ since: T0 + 50 });
      expect(lanes).toHaveLength(2);
      const quiet = lanes.find((l) => l.chatId === '-1');
      expect(quiet?.count).toBe(0);
      expect(quiet?.lastSentAt).toBe(T0);
      expect(lanes.find((l) => l.chatId === '-2')?.count).toBe(1);
    });

    it('filters to one bot by lane-key prefix', async () => {
      await store.record(entry({ messageId: 'a', botKey: 'bot-a' }));
      await store.record(entry({ messageId: 'b', botKey: 'bot-b' }));
      await store.record(entry({ messageId: 'c', platform: 'slack', botKey: 'bot-a' }));

      const lanes = await store.listLanes({
        laneKeyPrefix: transcriptLanePrefix('telegram', 'bot-a'),
      });
      expect(lanes.map((l) => l.laneKey)).toEqual([
        transcriptLaneKey('telegram', 'bot-a', '-100123'),
      ]);
    });

    it('matches the prefix literally — LIKE wildcards in a lane key are not patterns', async () => {
      // Lane keys are URL-encoded, so `%` and `_` occur in real ones
      // (`a%b_c` encodes to `a%25b_c`). A LIKE filter would read both as
      // wildcards and over-match onto the other bot.
      await store.record(entry({ messageId: 'x', botKey: 'a%b_c', chatId: '-1' }));
      await store.record(entry({ messageId: 'y', botKey: 'aXbYc', chatId: '-1' }));
      // `telegram:aQQ25bXc:` is what `LIKE 'telegram:a%25b_c:%'` reads as a
      // match — `%` swallowing `QQ` and `_` standing for `X`. A byte-exact
      // substr comparison excludes it.
      await store.record(entry({ messageId: 'z', botKey: 'aQQ25bXc', chatId: '-1' }));

      const prefix = transcriptLanePrefix('telegram', 'a%b_c');
      expect(prefix).toBe('telegram:a%25b_c:');
      const lanes = await store.listLanes({ laneKeyPrefix: prefix });
      expect(lanes).toHaveLength(1);
      expect(lanes[0]?.botKey).toBe('a%b_c');
    });

    it('finds nothing for an unencoded prefix a caller built by hand', async () => {
      // Why `transcriptLanePrefix` exists: the naive template in the plan
      // (`${platform}:${botKey}:`) misses the lane it meant to select.
      await store.record(entry({ messageId: 'x', botKey: 'a%b_c', chatId: '-1' }));
      expect(await store.listLanes({ laneKeyPrefix: 'telegram:a%b_c:' })).toEqual([]);
    });

    it('returns exactly one summary per lane however many messages it holds', async () => {
      // The lane walk joins each distinct lane key to its newest row. A join
      // that fanned out would report a lane once per message.
      for (let i = 0; i < 25; i++) {
        await store.record(entry({ messageId: `m${i}`, chatId: '-1', sentAt: T0 + i }));
      }
      await store.record(entry({ messageId: 'other', chatId: '-2', sentAt: T0 }));

      const lanes = await store.listLanes();
      expect(lanes).toHaveLength(2);
      expect(lanes.find((l) => l.chatId === '-1')).toMatchObject({
        count: 25,
        lastSentAt: T0 + 24,
      });
    });

    it('breaks a lastSentAt tie by lane key, ascending', async () => {
      await store.record(entry({ messageId: 'z', chatId: '-zz', sentAt: T0 }));
      await store.record(entry({ messageId: 'a', chatId: '-aa', sentAt: T0 }));

      expect((await store.listLanes()).map((l) => l.chatId)).toEqual(['-aa', '-zz']);
    });

    it('re-summarises a lane when an edit moves its newest message', async () => {
      await store.record(entry({ messageId: 'm1', chatId: '-1', sentAt: T0 }));
      await store.record(entry({ messageId: 'm2', chatId: '-1', sentAt: T0 + 10 }));
      // The upsert-on-edit path: m1 is rewritten past m2, so the lane's newest
      // message is no longer the row it was.
      await store.record(entry({ messageId: 'm1', chatId: '-1', text: 'edited', sentAt: T0 + 99 }));

      const lanes = await store.listLanes();
      expect(lanes).toHaveLength(1);
      expect(lanes[0]).toMatchObject({ count: 2, lastSentAt: T0 + 99 });
    });

    it('is empty on an empty store', async () => {
      expect(await store.listLanes()).toEqual([]);
    });
  });
});

describe('pruneChannelTranscript', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'channel-transcript-prune-'));
    dbPath = join(dir, 'channel-transcript.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('deletes rows past the window by recorded_at, not sent_at', async () => {
    const store = new SQLiteChannelTranscriptStore(dbPath);
    // Backdated `sentAt`, seen just now: retention must keep it.
    await store.record(entry({ messageId: 'backdated', sentAt: T0 - 90 * 86_400_000 }));
    // Sent "in the future", seen long ago: retention must drop it.
    await store.record(
      entry({ messageId: 'stale', sentAt: T0 + 86_400_000, recordedAt: T0 - 60 * 86_400_000 }),
    );
    store.close();

    const deleted = pruneChannelTranscript(dbPath, 30 * 86_400_000, { now: T0 });
    expect(deleted).toBe(1);

    const reopened = new SQLiteChannelTranscriptStore(dbPath);
    const lane = transcriptLaneKey('telegram', 'bot-a', '-100123');
    const page = await reopened.readSince(lane, 0);
    expect(page.messages.map((m) => m.messageId)).toEqual(['backdated']);
    reopened.close();
  });

  it('is a no-op for a forever retention', async () => {
    const store = new SQLiteChannelTranscriptStore(dbPath);
    await store.record(entry({ messageId: 'ancient', recordedAt: 0 }));
    store.close();

    expect(pruneChannelTranscript(dbPath, null, { now: T0 })).toBe(0);

    const reopened = new SQLiteChannelTranscriptStore(dbPath);
    const lane = transcriptLaneKey('telegram', 'bot-a', '-100123');
    expect((await reopened.readSince(lane, 0)).messages).toHaveLength(1);
    reopened.close();
  });

  it('does not create the database when observe mode was never used', () => {
    const missing = join(dir, 'never-written.db');
    expect(pruneChannelTranscript(missing, 30 * 86_400_000, { now: T0 })).toBe(0);
    expect(existsSync(missing)).toBe(false);
  });

  it('drops a fully-aged lane from listLanes and re-summarises a partial one', async () => {
    const store = new SQLiteChannelTranscriptStore(dbPath);
    // Lane A ages out entirely.
    await store.record(
      entry({ messageId: 'a1', chatId: '-1', sentAt: T0, recordedAt: T0 - 60 * 86_400_000 }),
    );
    await store.record(
      entry({ messageId: 'a2', chatId: '-1', sentAt: T0 + 5, recordedAt: T0 - 59 * 86_400_000 }),
    );
    // Lane B keeps only its OLDER message: the newest one is what prune takes,
    // so `lastSentAt` has to fall back rather than stay at the deleted row.
    await store.record(
      entry({ messageId: 'b1', chatId: '-2', sentAt: T0 + 900, recordedAt: T0 - 60 * 86_400_000 }),
    );
    await store.record(entry({ messageId: 'b2', chatId: '-2', sentAt: T0 + 100, recordedAt: T0 }));
    store.close();

    expect(pruneChannelTranscript(dbPath, 30 * 86_400_000, { now: T0 })).toBe(3);

    const reopened = new SQLiteChannelTranscriptStore(dbPath);
    const lanes = await reopened.listLanes();
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({ chatId: '-2', count: 1, lastSentAt: T0 + 100 });
    reopened.close();
  });

  it("waits for a peer process's write instead of failing the whole prune", async () => {
    // The bug this pins: the prune opens its OWN connection, and without a
    // busy timeout SQLite abandons the DELETE the instant the lock is held.
    // `ethos serve` and `ethos gateway` both run the `observability-prune`
    // job, so the holder is routinely the other process mid-`record()` on the
    // inbound path — and the throw comes out of the cron handler, leaving the
    // retention window quietly unenforced. Measured before the fix: threw at
    // 0ms. After: waited 25ms and deleted.
    //
    // The lock is held from a WORKER, not a second handle on this thread —
    // `@ethosagent/sqlite` is synchronous, so a same-thread holder could never
    // release while `pruneChannelTranscript` blocks. Plain CommonJS source so
    // no TypeScript transform is involved in the worker.
    const store = new SQLiteChannelTranscriptStore(dbPath);
    await store.record(entry({ messageId: 'aged', recordedAt: T0 - 60 * 86_400_000 }));
    store.close();

    const holder = new Worker(
      `const { DatabaseSync } = require('node:sqlite');
       const { workerData, parentPort } = require('node:worker_threads');
       const db = new DatabaseSync(workerData.dbPath);
       db.exec('PRAGMA busy_timeout = 5000');
       db.exec('BEGIN IMMEDIATE');
       db.prepare("INSERT INTO transcript (lane_key, platform, bot_key, chat_id, thread_id, sender_id, sender_name, text, message_id, sent_at, recorded_at) VALUES ('l','p','b','c',NULL,'u',NULL,'t','peer',1,${T0})").run();
       parentPort.postMessage('held');
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
       db.exec('COMMIT');
       db.close();`,
      { eval: true, workerData: { dbPath } },
    );
    await new Promise<void>((resolve, reject) => {
      holder.once('message', () => resolve());
      holder.once('error', reject);
    });

    // Runs while the peer holds the write lock. Pre-fix this threw.
    expect(pruneChannelTranscript(dbPath, 30 * 86_400_000, { now: T0 })).toBe(1);
    await holder.terminate();
  }, 30_000);

  it('stamps a fresh database at the current version and reopens it unchanged', async () => {
    // v2 is the AUTOINCREMENT rebuild. A future schema change has to add a
    // migration step and move this number deliberately.
    const store = new SQLiteChannelTranscriptStore(dbPath);
    await store.record(entry({ messageId: 'kept' }));
    store.close();

    const probe = new Database(dbPath);
    const version = (probe.pragma('user_version') as Array<{ user_version: number }>)[0];
    probe.close();
    expect(version?.user_version).toBe(2);

    const reopened = new SQLiteChannelTranscriptStore(dbPath);
    const again = new Database(dbPath);
    const after = (again.pragma('user_version') as Array<{ user_version: number }>)[0];
    again.close();
    // Reopening is not a second migration.
    expect(after?.user_version).toBe(2);
    const page = await reopened.readSince(transcriptLaneKey('telegram', 'bot-a', '-100123'), 0);
    expect(page.messages.map((m) => m.messageId)).toEqual(['kept']);
    reopened.close();
  });

  it('migrates a v1 database an earlier build wrote, and cursors it', async () => {
    // Builds the file the previous build did — that exact CREATE TABLE (plain
    // `INTEGER PRIMARY KEY`, no `transcript_lane_id`), `user_version = 1`,
    // rows inserted with no `id` supplied — then opens it through the
    // migrating store and reads. Ids must survive the rebuild verbatim: an id
    // IS the digest's persisted cursor.
    const seeded = new Database(dbPath);
    seeded.exec(`
      CREATE TABLE transcript (
        id          INTEGER PRIMARY KEY,
        lane_key    TEXT NOT NULL,
        platform    TEXT NOT NULL,
        bot_key     TEXT NOT NULL,
        chat_id     TEXT NOT NULL,
        thread_id   TEXT,
        sender_id   TEXT NOT NULL,
        sender_name TEXT,
        text        TEXT NOT NULL,
        message_id  TEXT,
        sent_at     INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX transcript_lane_sent ON transcript(lane_key, sent_at);
      CREATE INDEX transcript_recorded ON transcript(recorded_at);
      CREATE UNIQUE INDEX transcript_lane_message
        ON transcript(lane_key, message_id) WHERE message_id IS NOT NULL;
      PRAGMA user_version = 1;
    `);
    const lane = transcriptLaneKey('telegram', 'bot-a', '-100123');
    const insert = seeded.prepare(
      `INSERT INTO transcript
         (lane_key, platform, bot_key, chat_id, thread_id, sender_id, sender_name,
          text, message_id, sent_at, recorded_at)
       VALUES (?, 'telegram', 'bot-a', '-100123', NULL, 'u1', 'Ada', ?, ?, ?, ?)`,
    );
    insert.run(lane, 'written by the old build', 'old-1', T0, T0);
    insert.run(lane, 'and one more', 'old-2', T0 + 10, T0 + 10);
    seeded.close();

    const store = new SQLiteChannelTranscriptStore(dbPath);
    const page = await store.readSince(lane, 0);
    expect(page.messages.map((m) => m.messageId)).toEqual(['old-1', 'old-2']);
    // …and a capped read over that same file drains oldest-first, with no
    // schema step between the old build's rows and the new read.
    const first = await store.readSince(lane, 0, { limit: 1 });
    expect(first.messages.map((m) => m.messageId)).toEqual(['old-1']);
    expect(first.omittedCount).toBe(1);

    // Rows an earlier build wrote carry usable cursors, so a first digest over
    // an existing file consumes them exactly once.
    const cursor = page.messages[0]?.id ?? 0;
    expect((await store.readSince(lane, cursor)).messages.map((m) => m.messageId)).toEqual([
      'old-2',
    ]);

    const probe = new Database(dbPath);
    const version = (probe.pragma('user_version') as Array<{ user_version: number }>)[0];
    // Ids came across unchanged — the rows an earlier build wrote at 1 and 2
    // are still at 1 and 2, so a cursor stored against them still points where
    // it pointed.
    expect(page.messages.map((m) => m.id)).toEqual([1, 2]);
    // `sqlite_sequence` picked up the greatest copied id, so the sequence
    // continues from the migrated data rather than restarting under it.
    expect(
      probe.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'transcript'").get(),
    ).toEqual({ seq: 2 });
    // The rebuild recreates every index the baseline declares, including the
    // one v1 never had.
    expect(
      probe
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'transcript'")
        .all()
        .map((r) => (r as { name: string }).name)
        .filter((n) => !n.startsWith('sqlite_'))
        .sort(),
    ).toEqual([
      'transcript_lane_id',
      'transcript_lane_message',
      'transcript_lane_sent',
      'transcript_recorded',
    ]);
    probe.close();
    expect(version?.user_version).toBe(2);

    // A migrated file still writes, and still writes ABOVE what it holds.
    await store.record(entry({ messageId: 'post-migration', sentAt: T0 + 20 }));
    const drained = await store.readSince(lane, 2);
    expect(drained.messages.map((m) => m.messageId)).toEqual(['post-migration']);
    expect(drained.messages[0]?.id).toBe(3);
    store.close();
  });

  it('keeps ids above a consumed cursor after retention empties the table', async () => {
    // THE PERMANENT-SILENCE BUG. `id` is the digest's per-lane consumption
    // watermark. With a plain `INTEGER PRIMARY KEY` SQLite hands out
    // `max(rowid) + 1` OF THE SURVIVING ROWS, so once retention has pruned a
    // transcript empty the next message lands back at id 1 — under every
    // stored watermark. `readSince(lane, id > watermark)` then matches
    // nothing, forever, and nothing anywhere reports an error: the lane is
    // simply never digested again.
    //
    // Pre-fix this returned an EMPTY page at the last assertion.
    const lane = transcriptLaneKey('telegram', 'bot-a', '-100123');
    const store = new SQLiteChannelTranscriptStore(dbPath);
    for (const id of ['old-1', 'old-2', 'old-3']) {
      await store.record(entry({ messageId: id, recordedAt: T0 }));
    }

    // The digest consumes the lane and stores the greatest id it was handed.
    const digested = await store.readSince(lane, 0);
    expect(digested.messages).toHaveLength(3);
    const watermark = digested.messages.reduce((max, m) => (m.id > max ? m.id : max), 0);
    expect(watermark).toBe(3);
    store.close();

    // Nothing was said for longer than the retention window, so retention
    // takes the whole lane. Prune deletes by `recorded_at`, oldest first —
    // with nothing newer to stop at, that is every row in the file.
    expect(pruneChannelTranscript(dbPath, 30 * 86_400_000, { now: T0 + 60 * 86_400_000 })).toBe(3);
    const emptied = new Database(dbPath);
    expect(emptied.prepare('SELECT COUNT(*) AS n FROM transcript').get()).toEqual({ n: 0 });
    emptied.close();

    // The room wakes up.
    const after = new SQLiteChannelTranscriptStore(dbPath);
    await after.record(entry({ messageId: 'new-1', recordedAt: T0 + 61 * 86_400_000 }));
    await after.record(entry({ messageId: 'new-2', recordedAt: T0 + 61 * 86_400_000 }));

    // Everything recorded after the prune is still ABOVE the watermark the
    // digest is holding, so the next run sees it.
    const page = await after.readSince(lane, watermark);
    expect(page.messages.map((m) => m.messageId)).toEqual(['new-1', 'new-2']);
    expect(page.messages.every((m) => m.id > watermark)).toBe(true);
    after.close();
  });

  it('never reuses an id, however many times the table is emptied', async () => {
    // The guarantee behind the test above, stated directly: an id handed out
    // once is never handed out again, across any number of prune cycles.
    const lane = transcriptLaneKey('telegram', 'bot-a', '-100123');
    const store = new SQLiteChannelTranscriptStore(dbPath);
    const seen: number[] = [];
    for (let cycle = 0; cycle < 4; cycle++) {
      for (let i = 0; i < 3; i++) {
        await store.record(entry({ messageId: `c${cycle}-m${i}`, recordedAt: T0 }));
      }
      const page = await store.readSince(lane, 0);
      seen.push(...page.messages.map((m) => m.id));
      // Same connection the writer uses, so this is a prune landing under a
      // live store rather than a fresh file each round.
      expect(pruneChannelTranscript(dbPath, 1, { now: T0 + 86_400_000 })).toBe(3);
    }
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
    store.close();
  });
});

describe('listLanes at scale', () => {
  let dir: string;
  let dbPath: string;
  let store: SQLiteChannelTranscriptStore;

  const LANES = 200;
  const STEP = 1000;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'channel-transcript-scale-'));
    dbPath = join(dir, 'channel-transcript.db');
    store = new SQLiteChannelTranscriptStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Bulk-load through a second handle: `record()` per row is the slow path. */
  function seed(from: number, to: number): void {
    const db = new Database(dbPath);
    try {
      const insert = db.prepare(
        `INSERT INTO transcript
           (lane_key, platform, bot_key, chat_id, thread_id, sender_id, sender_name,
            text, message_id, sent_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      db.transaction(() => {
        for (let i = from; i < to; i++) {
          const chatId = `-100${i % LANES}`;
          insert.run(
            transcriptLaneKey('telegram', 'bot-a', chatId),
            'telegram',
            'bot-a',
            chatId,
            null,
            'u1',
            'Ada',
            `chatter ${i}`,
            `m${i}`,
            T0 + i * STEP,
            T0 + i * STEP,
          );
        }
      })();
    } finally {
      db.close();
    }
  }

  /** Median wall time of `listLanes` over a window holding one row per lane. */
  async function measure(rows: number): Promise<{ ms: number; lanes: number }> {
    const since = T0 + (rows - LANES) * STEP;
    let lanes = 0;
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = process.hrtime.bigint();
      const result = await store.listLanes({ since });
      runs.push(Number(process.hrtime.bigint() - started) / 1e6);
      lanes = result.length;
      expect(result.every((l) => l.count === 1)).toBe(true);
    }
    runs.sort((a, b) => a - b);
    return { ms: runs[2] ?? 0, lanes };
  }

  it('costs what the lane count costs, not what the message count costs', async () => {
    // The finding this pins: grouping the whole retained transcript makes a
    // 30s UI poll a synchronous scan whose cost grows with history. Timing a
    // RATIO rather than an absolute keeps the assertion machine-independent —
    // quadrupling the rows over an unchanged lane set must not quadruple the
    // call. Pre-fix this ran ~4x; the loose index scan runs ~1x.
    seed(0, 25_000);
    const small = await measure(25_000);
    expect(small.lanes).toBe(LANES);

    seed(25_000, 100_000);
    const big = await measure(100_000);
    expect(big.lanes).toBe(LANES);

    // `+ 5` absorbs sub-millisecond noise at the fast end without loosening
    // the guard: a linear scan of 100k rows is nowhere near 5ms.
    expect(big.ms).toBeLessThan(small.ms * 2 + 5);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Durability posture (see the `synchronous = NORMAL` note in the constructor)
// ---------------------------------------------------------------------------

/** Reads `PRAGMA synchronous` off the store's OWN handle. It is a per-connection
 *  setting, so a second connection to the same file would report its own
 *  default and prove nothing. 2 = FULL (SQLite's default), 1 = NORMAL. */
function syncPragma(store: unknown): number {
  const rows = (store as { db: { pragma(s: string): unknown } }).db.pragma('synchronous');
  return (rows as Array<{ synchronous: number }>)[0]?.synchronous ?? -1;
}

function journalMode(store: unknown): string {
  const rows = (store as { db: { pragma(s: string): unknown } }).db.pragma('journal_mode');
  return (rows as Array<{ journal_mode: string }>)[0]?.journal_mode ?? '';
}

describe('SQLiteChannelTranscriptStore — durability posture', () => {
  let dir: string;
  let store: SQLiteChannelTranscriptStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'transcript-sync-'));
    store = new SQLiteChannelTranscriptStore(join(dir, 'transcript.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens at synchronous = NORMAL', () => {
    // Asserted against the opened database, not the source text: this is the
    // trade the constructor's note argues for, and the observational nature of
    // this table is what pays for it.
    expect(syncPragma(store)).toBe(1);
  });

  it('still opens in WAL mode', () => {
    // NORMAL is only corruption-safe in WAL. If journal_mode ever regressed,
    // the setting above would stop being the trade it is documented as.
    expect(journalMode(store)).toBe('wal');
  });

  it('still enforces STRICT column types', () => {
    const db = (
      store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }
    ).db;
    expect(() =>
      db
        .prepare(
          `INSERT INTO transcript
             (lane_key, platform, bot_key, chat_id, thread_id, sender_id, sender_name,
              text, message_id, sent_at, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        // `sent_at` is INTEGER in a STRICT table, and 'soon' cannot be
        // losslessly converted to one, so STRICT must reject the row. (A
        // non-STRICT table would coerce it to 0 and store it.)
        .run('l', 'telegram', 'b', 'c', null, 'u', 'Ada', 'hi', null, 'soon', T0),
    ).toThrow();
  });
});
