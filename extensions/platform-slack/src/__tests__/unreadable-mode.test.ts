// A stored channel mode this build cannot read, driven through the REAL
// override store and BOTH real triage paths (`message` and `app_mention`).
//
// `channel-mode.test.ts` drives the evaluator directly, and `triage.test.ts`
// reaches its fail-closed branch through a hand-written stub store. Neither
// could reach it the way production does: the store dropped a record whose
// mode Slack's enum rejected, `get()` returned `undefined` —
// indistinguishable from "no override stored" — and triage substituted the
// configured default, `mention_only`, which ANSWERS. This suite goes through
// the file on disk.

import { ChannelOverrideStore } from '@ethosagent/core';
import type { Storage, StorageDirEntry } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { type ChannelMode, ChannelModeSchema } from '../config';
import {
  canSpeakInChannel,
  type RawSlackMention,
  type RawSlackMessage,
  resolveChannelMode,
  type TriageContext,
  triageMention,
  triageMessage,
} from '../routing/triage';

const BOT_DIR = '/slack/bot-a';
const FILE = `${BOT_DIR}/channel-overrides.jsonl`;

/** Not one shape of nonsense but every shape that actually reaches disk. */
const UNREADABLE = [
  'observe ', // trailing space
  'Observe', // wrong case
  'obserev', // typo
  'silent_digest_only', // a mode a newer binary knows and this one does not
  '', // empty
  // A mode that is real — on TELEGRAM. Slack has no `regex_match` and so
  // supplies no `matchesPattern`. `evaluateChannelMode` used to test a
  // hard-coded UNION of all four adapters' enums, under which this string was
  // "recognised" here: the message path dropped every message unrecorded
  // (`matchesPattern` undefined → never matches) while the mention path and
  // `canSpeakInChannel` fell through to the answering `isGroupMention` branch.
  // Slack now passes its own `CHANNEL_MODES` (`../config`) as `supportedModes`.
  'regex_match',
] as const;

/** Local, so the Slack package needs no devDependency on a sibling extension. */
function memStorage(): Storage {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const text = (c: string | Uint8Array) =>
    typeof c === 'string' ? c : Buffer.from(c).toString('utf-8');
  return {
    async read(p) {
      return files.get(p) ?? null;
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
    async list() {
      return [];
    },
    async listEntries(): Promise<StorageDirEntry[]> {
      return [];
    },
    async write(p, content) {
      files.set(p, text(content));
    },
    async append(p, content) {
      files.set(p, (files.get(p) ?? '') + content);
    },
    async writeAtomic(p, content) {
      files.set(p, text(content));
    },
    async mkdir(d) {
      dirs.add(d);
    },
    async remove(p) {
      files.delete(p);
      dirs.delete(p);
    },
    async rename() {},
    async chmod() {},
  };
}

async function storeWith(mode: string): Promise<ChannelOverrideStore<ChannelMode>> {
  const storage = memStorage();
  await storage.write(FILE, `${JSON.stringify({ channel: 'C1', mode, updatedAt: 1 })}\n`);
  const store = new ChannelOverrideStore(storage, BOT_DIR, ChannelModeSchema);
  await store.load();
  return store;
}

const channelMessage: RawSlackMessage = {
  channel: 'C1',
  user: 'U1',
  text: 'concrete pour slipped to thursday',
  ts: '111.222',
  channel_type: 'channel',
};

const mention: RawSlackMention = {
  channel: 'C1',
  user: 'U1',
  text: '<@BOT> are we on track?',
  ts: '111.222',
};

async function ctxWithStored(mode: string): Promise<TriageContext> {
  return {
    botKey: 'bot-a',
    defaultChannelMode: 'mention_only',
    channelOverrides: await storeWith(mode),
  };
}

describe('Slack: a stored mode this build cannot read', () => {
  for (const stored of UNREADABLE) {
    it(`neither answers nor records a channel message under ${JSON.stringify(stored)}`, async () => {
      const result = await triageMessage(channelMessage, await ctxWithStored(stored));

      expect(result.envelope).toBeUndefined();
      expect(result.drop).toBe('channel_mode');
    });

    it(`neither answers nor records an @mention under ${JSON.stringify(stored)}`, async () => {
      // The dangerous case: under the answering default this is exactly what
      // `mention_only` replies to.
      const result = await triageMention(mention, await ctxWithStored(stored));

      expect(result.envelope).toBeUndefined();
      expect(result.drop).toBe('channel_mode');
    });

    it(`reports ${JSON.stringify(stored)} verbatim rather than the default it is not`, async () => {
      // The diagnostic. `/ethos channel-mode show`, `/ethos help` and the Home
      // tab render this same value, so the operator who asks why a channel
      // went quiet is shown the string that silenced it.
      expect(resolveChannelMode('C1', await ctxWithStored(stored))).toBe(stored);
    });
  }

  for (const stored of UNREADABLE) {
    it(`silences every speaking surface under ${JSON.stringify(stored)}`, () => {
      // `canSpeakInChannel` is the single gate the three non-message surfaces
      // share — the `member_joined_channel` greeting (`../events/members.ts`),
      // the `link_shared` unfurl (`../events/links.ts`) and `/ethos ask`
      // (`../commands/ask.ts`). Asserted here rather than three times over,
      // because it is the same call with the same argument in all three.
      expect(canSpeakInChannel(stored, false)).toBe(false);
    });
  }

  it('a DM is still answered — a bad override must not deafen the bot to its owner', async () => {
    const result = await triageMessage(
      { ...channelMessage, channel_type: 'im' },
      await ctxWithStored('obserev'),
    );

    expect(result.envelope).toBeDefined();
    expect(result.envelope?.recordOnly).toBe(false);
  });
});

describe('Slack: the two cases that must NOT change', () => {
  it('an ABSENT override still falls back to the configured default', async () => {
    // The distinction the fix turns on: no record for this channel is not the
    // same as a record this build cannot read.
    const store = new ChannelOverrideStore(memStorage(), BOT_DIR, ChannelModeSchema);
    await store.load();
    const ctx: TriageContext = {
      botKey: 'bot-a',
      defaultChannelMode: 'all',
      channelOverrides: store,
    };

    expect(resolveChannelMode('C1', ctx)).toBe('all');
    const result = await triageMessage(channelMessage, ctx);
    expect(result.envelope).toBeDefined();
    expect(result.envelope?.recordOnly).toBe(false);
  });

  it('a VALID stored override behaves exactly as before', async () => {
    const ctx = await ctxWithStored('observe');

    expect(resolveChannelMode('C1', ctx)).toBe('observe');
    const result = await triageMention(mention, ctx);
    expect(result.envelope).toBeDefined();
    expect(result.envelope?.recordOnly).toBe(true);
  });
});
