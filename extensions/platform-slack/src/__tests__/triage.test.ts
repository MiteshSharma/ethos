import { describe, expect, it } from 'vitest';
import {
  type RawSlackMention,
  type RawSlackMessage,
  resolveChannelMode,
  stripMentions,
  type TriageContext,
  triageMention,
  triageMessage,
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
    const overrides = {
      get: (channel: string) => (channel === 'C123' ? ('all' as const) : undefined),
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
      get: (channel: string) => (channel === 'C1' ? ('all' as const) : undefined),
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
