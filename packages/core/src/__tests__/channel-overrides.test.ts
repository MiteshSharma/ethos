import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type ChannelModeParser, ChannelOverrideStore } from '../channel-overrides';

// The two enum shapes the four adapters bring: Discord/Slack's three modes and
// Telegram's four (it alone has `regex_match`). Both gain `observe`.
const SimpleModeSchema = z.enum(['mention_only', 'thread_follow', 'all', 'observe']);
type SimpleMode = z.infer<typeof SimpleModeSchema>;

const RegexModeSchema = z.enum(['mention_only', 'thread_follow', 'all', 'regex_match', 'observe']);
type RegexMode = z.infer<typeof RegexModeSchema>;

const DIR = '/root/.ethos/discord/bot123';
const FILE = `${DIR}/channel-overrides.jsonl`;

function makeStore(storage = new InMemoryStorage()) {
  return { storage, store: new ChannelOverrideStore(storage, DIR, SimpleModeSchema) };
}

/** Seed the JSONL directly, as a previous process would have left it. */
async function seed(storage: InMemoryStorage, content: string): Promise<void> {
  await storage.mkdir(DIR);
  await storage.write(FILE, content);
}

describe('ChannelOverrideStore — zod parameterisation', () => {
  it('accepts a zod enum directly as its mode parser', () => {
    // The contract the four adapters rely on: they pass their own
    // `ChannelModeSchema` in unchanged. `@ethosagent/core` never imports zod —
    // `ChannelModeParser` is structural — so this assignment is the only thing
    // standing between a widened enum and a runtime type error in an adapter.
    const simple: ChannelModeParser<SimpleMode> = SimpleModeSchema;
    const regex: ChannelModeParser<RegexMode> = RegexModeSchema;
    expect(simple.safeParse('observe').success).toBe(true);
    expect(regex.safeParse('regex_match').success).toBe(true);
    expect(simple.safeParse('regex_match').success).toBe(false);
  });

  it('keeps a stored mode the adapter enum does not know, verbatim', async () => {
    // A Telegram file read back by a Discord-shaped enum. The `regex_match`
    // line is not ADOPTED — no adapter treats it as one of its own modes, and
    // `evaluateChannelMode` fails closed on anything it does not recognise —
    // but it is kept, because dropping it is what made `get()` return
    // `undefined`, indistinguishable from "no override stored", so the caller
    // substituted its answering default.
    const storage = new InMemoryStorage();
    await seed(
      storage,
      `${JSON.stringify({ channel: 'c1', mode: 'regex_match', updatedAt: 1 })}\n` +
        `${JSON.stringify({ channel: 'c2', mode: 'observe', updatedAt: 2 })}\n`,
    );
    const store = new ChannelOverrideStore(storage, DIR, SimpleModeSchema);
    await store.load();
    expect(store.get('c1')).toEqual({ mode: 'regex_match' });
    expect(store.get('c2')).toEqual({ mode: 'observe' });
  });
});

describe('ChannelOverrideStore — index', () => {
  it('returns undefined for unknown channels', async () => {
    const { store } = makeStore();
    await store.load();
    expect(store.get('unknown')).toBeUndefined();
  });

  it('stores and retrieves a channel mode override', async () => {
    const { store } = makeStore();
    await store.set('ch1', 'all');
    expect(store.get('ch1')).toEqual({ mode: 'all' });
  });

  it('latest set wins for a given channel', async () => {
    const { store } = makeStore();
    await store.set('ch1', 'mention_only');
    await store.set('ch1', 'observe');
    expect(store.get('ch1')).toEqual({ mode: 'observe' });
  });

  it('entries returns every channel entry', async () => {
    const { store } = makeStore();
    await store.set('ch1', 'all');
    await store.set('ch2', 'observe');
    expect(store.entries()).toContainEqual(['ch1', { mode: 'all' }]);
    expect(store.entries()).toContainEqual(['ch2', { mode: 'observe' }]);
  });
});

describe('ChannelOverrideStore — persistence', () => {
  it('persists across store instances', async () => {
    const { storage, store } = makeStore();
    await store.set('ch1', 'observe');
    const reopened = new ChannelOverrideStore(storage, DIR, SimpleModeSchema);
    await reopened.load();
    expect(reopened.get('ch1')).toEqual({ mode: 'observe' });
  });

  it('appends one JSONL line per set, latest line winning on reload', async () => {
    const { storage, store } = makeStore();
    await store.set('ch1', 'all');
    await store.set('ch1', 'mention_only');
    const raw = (await storage.read(FILE)) ?? '';
    expect(raw.trim().split('\n')).toHaveLength(2);
    const reopened = new ChannelOverrideStore(storage, DIR, SimpleModeSchema);
    await reopened.load();
    expect(reopened.get('ch1')).toEqual({ mode: 'mention_only' });
  });

  it('writes the per-bot directory before appending', async () => {
    const { storage, store } = makeStore();
    await store.set('ch1', 'all');
    expect(await storage.exists(FILE)).toBe(true);
  });

  it('set works without an explicit load', async () => {
    const { storage, store } = makeStore();
    await seed(storage, `${JSON.stringify({ channel: 'ch0', mode: 'all', updatedAt: 1 })}\n`);
    await store.set('ch1', 'observe');
    // `set` loads first, so the pre-existing entry survives.
    expect(store.get('ch0')).toEqual({ mode: 'all' });
    expect(store.get('ch1')).toEqual({ mode: 'observe' });
  });

  it('load is idempotent', async () => {
    const { storage, store } = makeStore();
    await store.set('ch1', 'all');
    await storage.append(
      FILE,
      `${JSON.stringify({ channel: 'ch1', mode: 'observe', updatedAt: 9 })}\n`,
    );
    await store.load();
    // Already loaded — the second load must not re-read and clobber the index.
    expect(store.get('ch1')).toEqual({ mode: 'all' });
  });
});

describe('ChannelOverrideStore — malformed input', () => {
  it('skips corrupted lines and loads valid ones', async () => {
    const storage = new InMemoryStorage();
    const valid = JSON.stringify({ channel: 'ch1', mode: 'all', updatedAt: 1 });
    await seed(storage, `garbage\n${valid}\n{nope\n`);
    const store = new ChannelOverrideStore(storage, DIR, SimpleModeSchema);
    await store.load();
    expect(store.get('ch1')).toEqual({ mode: 'all' });
  });

  it('skips lines with a missing or wrongly-typed field', async () => {
    const storage = new InMemoryStorage();
    await seed(
      storage,
      [
        JSON.stringify({ mode: 'all', updatedAt: 1 }), // no channel
        JSON.stringify({ channel: 'c2', mode: 'all' }), // no updatedAt
        JSON.stringify({ channel: 'c3', mode: 'all', updatedAt: 'soon' }), // wrong type
        JSON.stringify({ channel: 'c4', mode: 'all', updatedAt: 1, regexPattern: 7 }),
        JSON.stringify(['not', 'an', 'object']),
        JSON.stringify(null),
        JSON.stringify({ channel: 'c7', mode: 'all', updatedAt: 1 }), // the good one
      ].join('\n'),
    );
    const store = new ChannelOverrideStore(storage, DIR, SimpleModeSchema);
    await store.load();
    expect(store.entries()).toEqual([['c7', { mode: 'all' }]]);
  });

  it('tolerates blank lines and a missing file', async () => {
    const storage = new InMemoryStorage();
    const empty = new ChannelOverrideStore(storage, DIR, SimpleModeSchema);
    await empty.load();
    expect(empty.entries()).toEqual([]);

    await seed(storage, `\n\n${JSON.stringify({ channel: 'c1', mode: 'all', updatedAt: 1 })}\n\n`);
    const store = new ChannelOverrideStore(storage, DIR, SimpleModeSchema);
    await store.load();
    expect(store.entries()).toEqual([['c1', { mode: 'all' }]]);
  });
});

// The store is what stands between a bad override string and
// `evaluateChannelMode`'s fail-closed branch. Dropping the record put the
// caller's ANSWERING default there instead, which is why that branch was dead
// code in production; keeping it is what makes the branch reachable.
describe('ChannelOverrideStore — an unreadable stored mode', () => {
  /** Every shape that actually reaches disk, not one shape of nonsense. */
  const UNREADABLE = ['observe ', 'Observe', 'obserev', 'silent_digest_only', ''];

  for (const mode of UNREADABLE) {
    it(`keeps ${JSON.stringify(mode)} verbatim instead of dropping the record`, async () => {
      const storage = new InMemoryStorage();
      await seed(storage, `${JSON.stringify({ channel: 'c1', mode, updatedAt: 1 })}\n`);
      const store = new ChannelOverrideStore(storage, DIR, SimpleModeSchema);
      await store.load();
      expect(store.get('c1')).toEqual({ mode });
    });
  }

  it('leaves an ABSENT override undefined — the distinction callers depend on', async () => {
    // `undefined` must keep meaning "no override stored, use your default".
    // If it also meant "stored but unreadable" the caller could not tell a
    // room that never chose a mode from a room whose choice it cannot read.
    const storage = new InMemoryStorage();
    await seed(storage, `${JSON.stringify({ channel: 'c1', mode: 'obserev', updatedAt: 1 })}\n`);
    const store = new ChannelOverrideStore(storage, DIR, SimpleModeSchema);
    await store.load();
    expect(store.get('c1')).toEqual({ mode: 'obserev' });
    expect(store.get('c2')).toBeUndefined();
  });

  it('still drops a record whose mode is not a string at all', async () => {
    // A non-string `mode` is structurally malformed, the same class as the
    // truncated line above — not a mode this build cannot read.
    const storage = new InMemoryStorage();
    await seed(
      storage,
      [
        JSON.stringify({ channel: 'c1', mode: 7, updatedAt: 1 }),
        JSON.stringify({ channel: 'c2', mode: null, updatedAt: 1 }),
        JSON.stringify({ channel: 'c3', updatedAt: 1 }),
      ].join('\n'),
    );
    const store = new ChannelOverrideStore(storage, DIR, SimpleModeSchema);
    await store.load();
    expect(store.entries()).toEqual([]);
  });

  it('latest record wins in both directions', async () => {
    const storage = new InMemoryStorage();
    await seed(
      storage,
      [
        JSON.stringify({ channel: 'c1', mode: 'observe', updatedAt: 1 }),
        JSON.stringify({ channel: 'c1', mode: 'obserev', updatedAt: 2 }),
        JSON.stringify({ channel: 'c2', mode: 'obserev', updatedAt: 1 }),
        JSON.stringify({ channel: 'c2', mode: 'observe', updatedAt: 2 }),
      ].join('\n'),
    );
    const store = new ChannelOverrideStore(storage, DIR, SimpleModeSchema);
    await store.load();
    expect(store.get('c1')).toEqual({ mode: 'obserev' });
    expect(store.get('c2')).toEqual({ mode: 'observe' });
  });

  it('a valid set replaces an unreadable record', async () => {
    const storage = new InMemoryStorage();
    await seed(storage, `${JSON.stringify({ channel: 'c1', mode: 'obserev', updatedAt: 1 })}\n`);
    const store = new ChannelOverrideStore(storage, DIR, SimpleModeSchema);
    await store.set('c1', 'all');
    expect(store.get('c1')).toEqual({ mode: 'all' });
    const reopened = new ChannelOverrideStore(storage, DIR, SimpleModeSchema);
    await reopened.load();
    expect(reopened.get('c1')).toEqual({ mode: 'all' });
  });
});

describe('ChannelOverrideStore — regexPattern column', () => {
  it('round-trips a pattern alongside the mode', async () => {
    const storage = new InMemoryStorage();
    const store = new ChannelOverrideStore(storage, DIR, RegexModeSchema);
    await store.set('ch1', 'regex_match', '^deploy\\b');
    const reopened = new ChannelOverrideStore(storage, DIR, RegexModeSchema);
    await reopened.load();
    expect(reopened.get('ch1')).toEqual({ mode: 'regex_match', regexPattern: '^deploy\\b' });
  });

  it('omits the key entirely when no pattern is supplied', async () => {
    const storage = new InMemoryStorage();
    const store = new ChannelOverrideStore(storage, DIR, RegexModeSchema);
    await store.set('ch1', 'all');
    expect(store.get('ch1')).not.toHaveProperty('regexPattern');
    expect((await storage.read(FILE)) ?? '').not.toContain('regexPattern');
  });

  it('a later set without a pattern clears the previous one', async () => {
    const storage = new InMemoryStorage();
    const store = new ChannelOverrideStore(storage, DIR, RegexModeSchema);
    await store.set('ch1', 'regex_match', 'deploy');
    await store.set('ch1', 'all');
    expect(store.get('ch1')).toEqual({ mode: 'all' });
    const reopened = new ChannelOverrideStore(storage, DIR, RegexModeSchema);
    await reopened.load();
    expect(reopened.get('ch1')).toEqual({ mode: 'all' });
  });
});
