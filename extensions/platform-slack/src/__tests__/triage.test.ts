import { describe, expect, it } from 'vitest';
import type { ChannelMode } from '../config';
import {
  type RawSlackMention,
  type RawSlackMessage,
  resolveChannelMode,
  stripMentions,
  type TriageContext,
  triageMention,
  triageMessage,
  tsToSentAt,
} from '../routing/triage';

const baseCtx: TriageContext = {
  botKey: 'bot-a',
  defaultChannelMode: 'mention_only',
};

const dmMessage: RawSlackMessage = {
  channel: 'D123',
  user: 'U1',
  text: 'hi',
  ts: '111.222',
  channel_type: 'im',
};

describe('triageMessage', () => {
  it('drops messages without text', async () => {
    const result = await triageMessage({ ...dmMessage, text: '   ' }, baseCtx);
    expect(result.envelope).toBeUndefined();
    expect(result.drop).toBe('no_text');
  });

  it('drops bot/edit subtypes', async () => {
    const result = await triageMessage({ ...dmMessage, subtype: 'message_changed' }, baseCtx);
    expect(result.envelope).toBeUndefined();
    expect(result.drop).toBe('subtype');
  });

  it('passes DMs through with no threadId when not threaded', async () => {
    const result = await triageMessage(dmMessage, baseCtx);
    expect(result.envelope).toBeDefined();
    expect(result.envelope?.isDm).toBe(true);
    expect(result.envelope?.threadId).toBeUndefined();
    expect(result.envelope?.botKey).toBe('bot-a');
  });

  it('drops public channel messages in mention_only mode', async () => {
    const channelMessage: RawSlackMessage = {
      channel: 'C123',
      user: 'U1',
      text: 'hello channel',
      ts: '111.222',
      channel_type: 'channel',
    };
    const result = await triageMessage(channelMessage, baseCtx);
    expect(result.envelope).toBeUndefined();
    expect(result.drop).toBe('channel_mode');
  });

  it('threaded messages set threadId to thread_ts', async () => {
    const threaded: RawSlackMessage = {
      channel: 'D123',
      user: 'U1',
      text: 'reply',
      ts: '999.000',
      thread_ts: '111.222',
      channel_type: 'im',
    };
    const result = await triageMessage(threaded, baseCtx);
    expect(result.envelope?.threadId).toBe('111.222');
    expect(result.envelope?.replyToId).toBe('111.222');
  });

  it('overrides default mode with explicit channel override', async () => {
    // `{ mode }` — the shared store (`@ethosagent/core`) indexes
    // `{ mode, regexPattern? }`, where Slack's own copy indexed a bare mode.
    const overrides = {
      get: (channel: string) => (channel === 'C123' ? ({ mode: 'all' } as const) : undefined),
    };
    const ctx: TriageContext = {
      botKey: 'bot-a',
      defaultChannelMode: 'mention_only',
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
      channelOverrides: overrides as any,
    };
    const channelMessage: RawSlackMessage = {
      channel: 'C123',
      user: 'U1',
      text: 'hi',
      ts: '111.222',
      channel_type: 'channel',
    };
    const result = await triageMessage(channelMessage, ctx);
    expect(result.envelope).toBeDefined();
    expect(result.effectiveMode).toBe('all');
  });

  // SP-B1 — bot/workflow allowlist (plan/phases/slack-parity-multimodal.md).
  // The gate is default-closed: a bot reaches the agent only when the operator
  // named its `bot_id`. The envelope stamps that `bot_id` as `userId` so the
  // gateway's channel filter — which allowlists by `userId` — still governs it.
  describe('bot/workflow allowlist', () => {
    const botMessage: RawSlackMessage = {
      channel: 'D123',
      text: 'deploy finished',
      ts: '111.222',
      channel_type: 'im',
      subtype: 'bot_message',
      bot_id: 'B_DEPLOY',
    };

    it('accepts an allowlisted bot and stamps userId with the bot_id', async () => {
      const result = await triageMessage(botMessage, { ...baseCtx, allowedBotIds: ['B_DEPLOY'] });
      expect(result.drop).toBeUndefined();
      expect(result.envelope?.text).toBe('deploy finished');
      // Load-bearing: the channel filter keys on `userId`, so the bot_id must
      // land here or the operator has no way to allowlist the bot downstream.
      expect(result.envelope?.userId).toBe('B_DEPLOY');
    });

    it('drops a bot that is not on the allowlist', async () => {
      const result = await triageMessage(botMessage, { ...baseCtx, allowedBotIds: ['B_OTHER'] });
      expect(result.envelope).toBeUndefined();
      expect(result.drop).toBe('subtype');
    });

    it('drops every bot when the allowlist is absent (default-closed)', async () => {
      const result = await triageMessage(botMessage, baseCtx);
      expect(result.envelope).toBeUndefined();
      expect(result.drop).toBe('subtype');
    });

    it('drops every bot when the allowlist is empty (default-closed)', async () => {
      const result = await triageMessage(botMessage, { ...baseCtx, allowedBotIds: [] });
      expect(result.envelope).toBeUndefined();
      expect(result.drop).toBe('subtype');
    });

    it('leaves a human message untouched when an allowlist is configured', async () => {
      const result = await triageMessage(dmMessage, { ...baseCtx, allowedBotIds: ['B_DEPLOY'] });
      expect(result.envelope?.userId).toBe('U1');
    });
  });

  it('thread_follow consults thread state when present', async () => {
    const threadState = {
      hasBotPosted: (channel: string, ts: string) => channel === 'C123' && ts === 'T1',
    };
    const ctx: TriageContext = {
      botKey: 'bot-a',
      defaultChannelMode: 'thread_follow',
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
      threadState: threadState as any,
    };
    const inThread: RawSlackMessage = {
      channel: 'C123',
      user: 'U1',
      text: 'follow up',
      ts: '999.000',
      thread_ts: 'T1',
      channel_type: 'channel',
    };
    const result = await triageMessage(inThread, ctx);
    expect(result.envelope).toBeDefined();
  });
});

describe('triageMention', () => {
  it('strips mention tokens from the text', async () => {
    const evt: RawSlackMention = {
      channel: 'C1',
      user: 'U2',
      text: '<@U999> please help',
      ts: '111.222',
    };
    const result = await triageMention(evt, baseCtx);
    expect(result.envelope?.text).toBe('please help');
    expect(result.envelope?.isGroupMention).toBe(true);
  });

  it('drops mentions whose text is empty after stripping', async () => {
    const evt: RawSlackMention = {
      channel: 'C1',
      user: 'U2',
      text: '<@U999>',
      ts: '111.222',
    };
    const result = await triageMention(evt, baseCtx);
    expect(result.envelope).toBeUndefined();
    expect(result.drop).toBe('no_text');
  });
});

describe('resolveChannelMode', () => {
  it('falls back to default when no override', () => {
    const mode = resolveChannelMode('C1', baseCtx);
    expect(mode).toBe('mention_only');
  });

  it('honors channel override', () => {
    const overrides = {
      get: (channel: string) => (channel === 'C1' ? ({ mode: 'all' } as const) : undefined),
    };
    const mode = resolveChannelMode('C1', {
      ...baseCtx,
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
      channelOverrides: overrides as any,
    });
    expect(mode).toBe('all');
  });
});

describe('stripMentions', () => {
  it('removes mention tokens', () => {
    expect(stripMentions('hi <@U123>')).toBe('hi ');
    expect(stripMentions('<@U123><@U456> what')).toBe(' what');
  });
});

// ---------------------------------------------------------------------------
// Observe mode (plan/phases/ambient-group-monitoring.md §2, R11)
//
// Slack's two inbound paths are separate handlers, and observe mode has to
// hold on BOTH of them. `triageMessage` is mention-blind; `triageMention` is
// the path every @mention in every channel takes, so its regression suite is
// the load-bearing one — a wiring mistake there breaks all Slack mentions, not
// just observed ones.
// ---------------------------------------------------------------------------

const channelPost: RawSlackMessage = {
  channel: 'C_SITE_7',
  user: 'U_STRANGER',
  text: 'concrete pour slipped to thursday',
  ts: '1699000000.123456',
  channel_type: 'channel',
};

const mention: RawSlackMention = {
  channel: 'C_SITE_7',
  user: 'U_STRANGER',
  text: '<@U0BOT99> are we on track?',
  ts: '1699000000.123456',
};

const ctxWith = (mode: ChannelMode): TriageContext => ({
  botKey: 'bot-a',
  defaultChannelMode: mode,
});

describe('triageMessage — observe mode', () => {
  it('records an unmentioned channel post instead of dropping it', async () => {
    const result = await triageMessage(channelPost, ctxWith('observe'));

    expect(result.drop).toBeUndefined();
    expect(result.envelope?.recordOnly).toBe(true);
    expect(result.envelope?.text).toBe('concrete pour slipped to thursday');
  });

  it('a DM is still a conversation, never record-only', async () => {
    const result = await triageMessage(
      { ...channelPost, channel: 'D1', channel_type: 'im' },
      ctxWith('observe'),
    );

    expect(result.envelope?.recordOnly).toBe(false);
  });

  it('all: still answered, stamped recordOnly false', async () => {
    const result = await triageMessage(channelPost, ctxWith('all'));

    expect(result.envelope?.recordOnly).toBe(false);
  });

  it('mention_only: an unmentioned post still reaches nothing at all', async () => {
    const result = await triageMessage(channelPost, ctxWith('mention_only'));

    expect(result.envelope).toBeUndefined();
    expect(result.drop).toBe('channel_mode');
  });
});

// Every Slack @mention goes through here. These four cases are the regression
// guard on the observe branch: the first three must keep replying exactly as
// they did before observe existed, and only the fourth may fall silent.
describe('triageMention — every mode still reaches the agent', () => {
  it('mention_only: a mention is answered', async () => {
    const result = await triageMention(mention, ctxWith('mention_only'));

    expect(result.envelope).toBeDefined();
    expect(result.envelope?.isGroupMention).toBe(true);
    expect(result.envelope?.recordOnly).toBe(false);
    expect(result.envelope?.text).toBe('are we on track?');
  });

  it('all: a mention is answered', async () => {
    const result = await triageMention(mention, ctxWith('all'));

    expect(result.envelope).toBeDefined();
    expect(result.envelope?.recordOnly).toBe(false);
  });

  it('thread_follow: a mention is answered even with no prior bot post', async () => {
    const result = await triageMention(mention, ctxWith('thread_follow'));

    expect(result.envelope).toBeDefined();
    expect(result.envelope?.recordOnly).toBe(false);
  });

  it('an unrecognised stored mode still answers a mention', async () => {
    const result = await triageMention(mention, {
      botKey: 'bot-a',
      // A mode written by a newer build, or hand-edited into the JSONL. The
      // shared evaluator falls through to the mention baseline; the bot must
      // not go silent because it failed to recognise a word.
      defaultChannelMode: 'from_the_future' as unknown as ChannelMode,
    });

    expect(result.envelope).toBeDefined();
    expect(result.envelope?.recordOnly).toBe(false);
  });

  // The product decision worth a test of its own: silence in an observed
  // channel must not be conditional on what a third party types.
  it('observe: a mention is recorded and still not answered', async () => {
    const result = await triageMention(mention, ctxWith('observe'));

    expect(result.envelope).toBeDefined();
    expect(result.envelope?.isGroupMention).toBe(true);
    expect(result.envelope?.recordOnly).toBe(true);
    expect(result.envelope?.text).toBe('are we on track?');
  });

  it('observe: an empty mention is still dropped for no text', async () => {
    const result = await triageMention({ ...mention, text: '<@U0BOT99>' }, ctxWith('observe'));

    expect(result.envelope).toBeUndefined();
    expect(result.drop).toBe('no_text');
  });
});

describe('sentAt — Slack ts, not receipt time', () => {
  it('converts the seconds-with-fraction ts to epoch milliseconds', () => {
    expect(tsToSentAt('1699000000.123456')).toBe(1_699_000_000_123);
  });

  it('leaves sentAt unset when the platform gave no ts', () => {
    expect(tsToSentAt(undefined)).toBeUndefined();
    expect(tsToSentAt('')).toBeUndefined();
    expect(tsToSentAt('not-a-timestamp')).toBeUndefined();
  });

  it('stamps a message envelope with the platform send time', async () => {
    const result = await triageMessage(channelPost, ctxWith('all'));

    expect(result.envelope?.sentAt).toBe(1_699_000_000_123);
    expect(result.envelope?.sentAt).not.toBe(Date.now());
  });

  it('stamps a mention envelope with the platform send time', async () => {
    const result = await triageMention(mention, ctxWith('mention_only'));

    expect(result.envelope?.sentAt).toBe(1_699_000_000_123);
  });

  it('stamps a record-only envelope too', async () => {
    const result = await triageMessage(channelPost, ctxWith('observe'));

    expect(result.envelope?.sentAt).toBe(1_699_000_000_123);
  });

  it('omits sentAt entirely when ts is absent', async () => {
    const result = await triageMessage({ ...channelPost, ts: undefined }, ctxWith('all'));

    expect(result.envelope).toBeDefined();
    expect(result.envelope?.sentAt).toBeUndefined();
  });
});
