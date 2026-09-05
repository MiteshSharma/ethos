import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CallLog,
  InMemoryCallLog,
  MAX_RECENT_CALLS,
  SQLiteCallLog,
  type StartCallInput,
} from '../index';

interface Backend {
  name: string;
  setup: () => { log: CallLog; cleanup: () => void };
}

const backends: Backend[] = [
  {
    name: 'SQLiteCallLog',
    setup: () => {
      const dir = mkdtempSync(join(tmpdir(), 'ethos-call-log-'));
      const log = new SQLiteCallLog({ path: join(dir, 'nested', 'calls.db') });
      return {
        log,
        cleanup: () => {
          log.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
  {
    name: 'InMemoryCallLog',
    setup: () => {
      const log = new InMemoryCallLog();
      return { log, cleanup: () => log.close() };
    },
  },
];

function input(overrides: Partial<StartCallInput> & { id: string }): StartCallInput {
  return {
    botKey: 'bot-a',
    laneKey: `voice:bot-a:sip:+15550001`,
    direction: 'inbound',
    fromNumber: '+15550001',
    toNumber: '+15559999',
    startedAt: 1_000,
    ...overrides,
  };
}

describe.each(backends)('CallLog conformance — $name', ({ setup }) => {
  let log: CallLog;
  let cleanup: () => void;

  beforeEach(() => {
    const out = setup();
    log = out.log;
    cleanup = out.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it('round-trips a call with every optional field absent', async () => {
    const id = await log.start({
      id: 'call-1',
      botKey: 'bot-a',
      laneKey: 'voice:bot-a:sip:+15550001',
      direction: 'inbound',
      fromNumber: '+15550001',
      toNumber: '+15559999',
      startedAt: 1_000,
    });
    expect(id).toBe('call-1');

    expect(await log.get('call-1')).toEqual({
      id: 'call-1',
      botKey: 'bot-a',
      laneKey: 'voice:bot-a:sip:+15550001',
      direction: 'inbound',
      fromNumber: '+15550001',
      toNumber: '+15559999',
      personalityId: undefined,
      tier: undefined,
      status: 'ringing',
      startedAt: 1_000,
      endedAt: undefined,
      reason: undefined,
      summary: undefined,
      transcript: undefined,
      costUsd: undefined,
    });
  });

  it('round-trips a call with every optional field present', async () => {
    const full: StartCallInput = {
      id: 'call-full',
      botKey: 'bot-b',
      laneKey: 'voice:bot-b:sip:+15550002',
      direction: 'outbound',
      fromNumber: '+15559999',
      toNumber: '+15550002',
      personalityId: 'atlas',
      tier: 'realtime',
      status: 'completed',
      startedAt: 2_000,
      endedAt: 2_500,
      reason: 'over_budget',
      summary: 'Confirmed the delivery window.',
      transcript: 'caller: hello\nagent: hello',
      costUsd: 0.42,
    };
    await log.start(full);

    expect(await log.get('call-full')).toEqual({ ...full, status: 'completed' });
  });

  it('returns null for an unknown id', async () => {
    expect(await log.get('nope')).toBeNull();
  });

  it('rejects a duplicate start rather than overwriting', async () => {
    await log.start(input({ id: 'call-1', summary: 'original' }));
    await expect(log.start(input({ id: 'call-1', summary: 'replacement' }))).rejects.toThrow();
    expect((await log.get('call-1'))?.summary).toBe('original');
  });

  it('patches only the supplied fields', async () => {
    await log.start(input({ id: 'call-1', personalityId: 'atlas', tier: 'pipeline' }));
    await log.update('call-1', { status: 'live' });
    await log.update('call-1', {
      status: 'completed',
      endedAt: 5_000,
      summary: 'done',
      costUsd: 1.25,
    });

    const record = await log.get('call-1');
    expect(record).toMatchObject({
      status: 'completed',
      endedAt: 5_000,
      summary: 'done',
      costUsd: 1.25,
      // Untouched by either patch.
      personalityId: 'atlas',
      tier: 'pipeline',
      startedAt: 1_000,
      laneKey: 'voice:bot-a:sip:+15550001',
    });
    expect(record?.transcript).toBeUndefined();
  });

  it('treats an update of an unknown id as a no-op', async () => {
    await expect(log.update('ghost', { status: 'completed' })).resolves.toBeUndefined();
    expect(await log.get('ghost')).toBeNull();
  });

  it('treats an empty patch as a no-op', async () => {
    await log.start(input({ id: 'call-1' }));
    await log.update('call-1', {});
    expect((await log.get('call-1'))?.status).toBe('ringing');
  });

  it('lists recent calls newest first', async () => {
    await log.start(input({ id: 'old', startedAt: 1_000 }));
    await log.start(input({ id: 'new', startedAt: 3_000 }));
    await log.start(input({ id: 'mid', startedAt: 2_000 }));

    expect((await log.listRecent()).map((c) => c.id)).toEqual(['new', 'mid', 'old']);
  });

  it('breaks same-startedAt ties by insertion order, newest inserted first', async () => {
    await log.start(input({ id: 'first', startedAt: 7_000 }));
    await log.start(input({ id: 'second', startedAt: 7_000 }));
    await log.start(input({ id: 'third', startedAt: 7_000 }));

    const once = (await log.listRecent()).map((c) => c.id);
    const twice = (await log.listRecent()).map((c) => c.id);
    expect(once).toEqual(['third', 'second', 'first']);
    // Deterministic across reads — a list that reshuffles is unusable as a UI.
    expect(twice).toEqual(once);
  });

  it('defaults, honours and clamps the recent limit', async () => {
    for (let i = 0; i < MAX_RECENT_CALLS + 10; i++) {
      await log.start(input({ id: `call-${i}`, startedAt: 1_000 + i }));
    }

    expect(await log.listRecent()).toHaveLength(50);
    expect(await log.listRecent({ limit: 3 })).toHaveLength(3);
    expect(await log.listRecent({ limit: 10_000 })).toHaveLength(MAX_RECENT_CALLS);
  });

  it('filters listRecent by botKeys', async () => {
    await log.start(input({ id: 'a1', botKey: 'bot-a', startedAt: 1_000 }));
    await log.start(input({ id: 'b1', botKey: 'bot-b', startedAt: 2_000 }));
    await log.start(input({ id: 'c1', botKey: 'bot-c', startedAt: 3_000 }));

    expect((await log.listRecent({ botKeys: ['bot-a', 'bot-c'] })).map((c) => c.id)).toEqual([
      'c1',
      'a1',
    ]);
    expect(await log.listRecent({ botKeys: [] })).toEqual([]);
  });

  it('lists only ringing and live calls, oldest first', async () => {
    await log.start(input({ id: 'live-late', status: 'live', startedAt: 4_000 }));
    await log.start(input({ id: 'ringing-early', status: 'ringing', startedAt: 2_000 }));
    await log.start(input({ id: 'completed', status: 'completed', startedAt: 1_000 }));
    await log.start(input({ id: 'screened', status: 'screened', startedAt: 1_500 }));
    await log.start(input({ id: 'refused', status: 'refused', startedAt: 1_600 }));
    await log.start(input({ id: 'failed', status: 'failed', startedAt: 1_700 }));

    expect((await log.listLive()).map((c) => c.id)).toEqual(['ringing-early', 'live-late']);
  });

  it('filters listLive by botKeys', async () => {
    await log.start(input({ id: 'a-live', botKey: 'bot-a', status: 'live', startedAt: 1_000 }));
    await log.start(input({ id: 'b-live', botKey: 'bot-b', status: 'live', startedAt: 2_000 }));

    expect((await log.listLive(['bot-b'])).map((c) => c.id)).toEqual(['b-live']);
    expect(await log.listLive([])).toEqual([]);
  });

  it('prunes terminal rows past the cutoff and never live ones', async () => {
    await log.start(input({ id: 'done-old', status: 'completed', startedAt: 100, endedAt: 200 }));
    await log.start(input({ id: 'screened-old', status: 'screened', startedAt: 150 }));
    await log.start(input({ id: 'failed-old', status: 'failed', startedAt: 160, endedAt: 300 }));
    await log.start(input({ id: 'refused-recent', status: 'refused', startedAt: 5_000 }));
    // Older than the cutoff, but live — the invariant this store exists to hold.
    await log.start(input({ id: 'ringing-ancient', status: 'ringing', startedAt: 10 }));
    await log.start(input({ id: 'live-ancient', status: 'live', startedAt: 20 }));

    expect(await log.pruneEnded(1_000)).toBe(3);

    const remaining = (await log.listRecent()).map((c) => c.id).sort();
    expect(remaining).toEqual(['live-ancient', 'refused-recent', 'ringing-ancient']);
    expect(await log.pruneEnded(1_000)).toBe(0);
  });

  it('prunes a terminal row by endedAt, not startedAt, when both exist', async () => {
    // Started before the cutoff, ended after it — a long call that is still
    // recent history.
    await log.start(input({ id: 'long', status: 'completed', startedAt: 100, endedAt: 9_000 }));
    expect(await log.pruneEnded(1_000)).toBe(0);
    expect(await log.get('long')).not.toBeNull();
  });
});

describe('SQLiteCallLog', () => {
  let dir: string;
  let log: SQLiteCallLog;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ethos-call-log-strict-'));
    log = new SQLiteCallLog({ path: join(dir, 'calls.db') });
  });

  afterEach(() => {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a wrong-typed value instead of coercing it (STRICT)', async () => {
    // The table is STRICT, so a TEXT that cannot losslessly become an INTEGER
    // or a REAL raises rather than silently landing as 0 or NULL.
    await expect(
      log.start({ ...input({ id: 'bad-int' }), startedAt: 'soon' as unknown as number }),
    ).rejects.toThrow();

    await expect(
      log.start({ ...input({ id: 'bad-real' }), costUsd: 'free' as unknown as number }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Durability posture — see AGENTS.md's SQLite store roster.
// ---------------------------------------------------------------------------

/** Reads `PRAGMA synchronous` off the store's OWN handle — it is a
 *  per-connection setting, so a second connection to the same file would
 *  report its own default and prove nothing. 2 = FULL (SQLite's default),
 *  1 = NORMAL. */
function syncPragma(store: unknown): number {
  const rows = (store as { db: { pragma(s: string): unknown } }).db.pragma('synchronous');
  return (rows as Array<{ synchronous: number }>)[0]?.synchronous ?? -1;
}

describe('SQLiteCallLog — durability posture', () => {
  it('stays at synchronous = FULL', () => {
    // NOT a candidate for `synchronous = NORMAL` — pinned so a later blanket
    // sweep cannot take it silently.
    //
    // It looks like observational data next to the channel transcript, and it
    // is not: `ringing` and `live` rows are LIVE STATE (see the note at the
    // top of index.ts), and nothing here deletes them however old they look.
    // Independently of that, the write path is a handful of commits per phone
    // call — a human-scale event — so NORMAL would buy nothing measurable in
    // exchange for the risk.
    const store = new SQLiteCallLog({ path: ':memory:' });
    // Asserted against the opened database, not the source text.
    expect(syncPragma(store)).toBe(2);
    store.close();
  });
});
