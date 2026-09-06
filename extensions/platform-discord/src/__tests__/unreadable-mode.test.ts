// A stored channel mode this build cannot read, driven through the REAL
// override store and the REAL triage path.
//
// The distinction this suite exists for: `evaluateChannelMode` fails closed on
// a mode it does not recognise, but until the store kept such a record that
// branch was unreachable in production. The store dropped the line, `get()`
// returned `undefined` — indistinguishable from "no override stored" — and
// triage substituted the configured default, `mention_only`, which ANSWERS.
// A trailing space, a capital letter, a typo, or a silent mode written by a
// newer binary each turned a room that had asked for silence into an
// answering bot.
//
// `channel-mode.test.ts` drives the evaluator directly, where these strings
// can never arrive. This drives them from disk.

import { ChannelOverrideStore } from '@ethosagent/core';
import { describe, expect, it } from 'vitest';
import { ChannelModeSchema } from '../config';
import { resolveChannelMode, triageMessage } from '../routing/triage';
import { createInMemoryStorage } from './fakes';

const BOT_DIR = 'discord/bot-a';
const FILE = `${BOT_DIR}/channel-overrides.jsonl`;

/** Not one shape of nonsense but every shape that actually reaches disk. */
const UNREADABLE = [
  'observe ', // trailing space
  'Observe', // wrong case
  'obserev', // typo
  'silent_digest_only', // a mode a newer binary knows and this one does not
  '', // empty
  // A mode that is real — on TELEGRAM. Discord has no `regex_match` and so
  // supplies no `matchesPattern`. `evaluateChannelMode` used to test a
  // hard-coded UNION of all four adapters' enums, under which this string was
  // "recognised" here and the mention path fell through to the answering
  // `isGroupMention` branch while the unmentioned path recorded nothing.
  // Discord now passes its own `CHANNEL_MODES` (`../config`) as `supportedModes`.
  'regex_match',
] as const;

async function storeWith(
  mode: string,
): Promise<ChannelOverrideStore<'mention_only' | 'thread_follow' | 'all' | 'observe'>> {
  const storage = createInMemoryStorage();
  await storage.write(FILE, `${JSON.stringify({ channel: 'ch1', mode, updatedAt: 1 })}\n`);
  const store = new ChannelOverrideStore(storage, BOT_DIR, ChannelModeSchema);
  await store.load();
  return store;
}

function groupMessage(isMention: boolean) {
  return {
    channelId: 'ch1',
    userId: 'u1',
    text: isMention ? '<@bot> are we on track?' : 'concrete pour slipped to thursday',
    messageId: 'm1',
    isDm: false,
    isThread: false,
    isMention,
    sentAt: 1_700_000_000_000,
    raw: {},
  };
}

describe('Discord: a stored mode this build cannot read', () => {
  for (const stored of UNREADABLE) {
    it(`neither answers nor records an unmentioned message under ${JSON.stringify(stored)}`, async () => {
      const result = await triageMessage(groupMessage(false), {
        botKey: 'bot-a',
        defaultChannelMode: 'mention_only',
        channelOverrides: await storeWith(stored),
      });

      expect(result.envelope).toBeUndefined();
      expect(result.drop).toBe('channel_mode');
    });

    it(`neither answers nor records an @mention under ${JSON.stringify(stored)}`, async () => {
      // The mention is the dangerous case: under the answering default it is
      // exactly what `mention_only` replies to.
      const result = await triageMessage(groupMessage(true), {
        botKey: 'bot-a',
        defaultChannelMode: 'mention_only',
        channelOverrides: await storeWith(stored),
      });

      expect(result.envelope).toBeUndefined();
      expect(result.drop).toBe('channel_mode');
    });

    it(`reports ${JSON.stringify(stored)} verbatim rather than the default it is not`, async () => {
      // The diagnostic. `/ethos help` renders this same value, so the operator
      // who asks why a channel went quiet is shown the string that silenced
      // it instead of a default that is not in force.
      expect(
        resolveChannelMode('ch1', {
          botKey: 'bot-a',
          defaultChannelMode: 'mention_only',
          channelOverrides: await storeWith(stored),
        }),
      ).toBe(stored);
    });
  }

  it('a DM is still answered — a bad override must not deafen the bot to its owner', async () => {
    const result = await triageMessage(
      { ...groupMessage(false), isDm: true },
      {
        botKey: 'bot-a',
        defaultChannelMode: 'mention_only',
        channelOverrides: await storeWith('obserev'),
      },
    );

    expect(result.envelope).toBeDefined();
    expect(result.envelope?.recordOnly).toBe(false);
  });
});

describe('Discord: the two cases that must NOT change', () => {
  it('an ABSENT override still falls back to the configured default', async () => {
    // The distinction the fix turns on: no record for this channel is not the
    // same as a record this build cannot read.
    const storage = createInMemoryStorage();
    const store = new ChannelOverrideStore(storage, BOT_DIR, ChannelModeSchema);
    await store.load();

    const ctx = { botKey: 'bot-a', defaultChannelMode: 'all' as const, channelOverrides: store };
    expect(resolveChannelMode('ch1', ctx)).toBe('all');
    const result = await triageMessage(groupMessage(false), ctx);
    expect(result.envelope).toBeDefined();
    expect(result.envelope?.recordOnly).toBe(false);
  });

  it('a VALID stored override behaves exactly as before', async () => {
    const store = await storeWith('observe');
    const ctx = {
      botKey: 'bot-a',
      defaultChannelMode: 'mention_only' as const,
      channelOverrides: store,
    };

    expect(resolveChannelMode('ch1', ctx)).toBe('observe');
    const result = await triageMessage(groupMessage(true), ctx);
    expect(result.envelope).toBeDefined();
    expect(result.envelope?.recordOnly).toBe(true);
  });
});
