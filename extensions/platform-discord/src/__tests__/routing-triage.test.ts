import { describe, expect, it } from 'vitest';
import type { ChannelMode } from '../config';
import type { RawDiscordMessage, TriageContext } from '../routing/triage';
import { resolveChannelMode, stripMentions, triageMessage } from '../routing/triage';
import { ThreadStateStore } from '../store/thread-state';
import { createInMemoryStorage } from './fakes';

describe('routing triage', () => {
  const ctx: TriageContext = {
    botKey: 'test-bot',
    defaultChannelMode: 'mention_only',
  };

  it('triageMessage drops empty text', async () => {
    const result = await triageMessage(
      {
        channelId: 'ch1',
        userId: 'user1',
        text: '',
        messageId: 'msg1',
        isDm: false,
        isThread: false,
        isMention: false,
        sentAt: 1_700_000_000_000,
        raw: {},
      },
      ctx,
    );
    expect(result.drop).toBe('no_text');
  });

  it('triageMessage produces envelope for DMs', async () => {
    const result = await triageMessage(
      {
        channelId: 'dm-ch',
        userId: 'user1',
        text: 'hello',
        messageId: 'msg1',
        isDm: true,
        isThread: false,
        isMention: false,
        sentAt: 1_700_000_000_000,
        raw: {},
      },
      ctx,
    );
    expect(result.envelope).toBeDefined();
    expect(result.envelope?.platform).toBe('discord');
    expect(result.envelope?.botKey).toBe('test-bot');
    expect(result.envelope?.isDm).toBe(true);
  });

  it('triageMessage drops non-DM non-mention in mention_only mode', async () => {
    const result = await triageMessage(
      {
        channelId: 'ch1',
        userId: 'user1',
        text: 'hello',
        messageId: 'msg1',
        isDm: false,
        isThread: false,
        isMention: false,
        sentAt: 1_700_000_000_000,
        raw: {},
      },
      ctx,
    );
    expect(result.drop).toBe('channel_mode');
  });

  it('triageMessage accepts @mentions in mention_only mode', async () => {
    const result = await triageMessage(
      {
        channelId: 'ch1',
        userId: 'user1',
        text: '<@bot123> what is this?',
        messageId: 'msg1',
        isDm: false,
        isThread: false,
        isMention: true,
        sentAt: 1_700_000_000_000,
        raw: {},
      },
      ctx,
    );
    expect(result.envelope).toBeDefined();
    expect(result.envelope?.isGroupMention).toBe(true);
  });

  it('triageMessage sets threadId for threaded messages', async () => {
    const result = await triageMessage(
      {
        channelId: 'thread-ch',
        userId: 'user1',
        text: 'reply in thread',
        messageId: 'msg1',
        isDm: true,
        isThread: true,
        threadId: 'thread-ch',
        parentChannelId: 'parent-ch',
        isMention: false,
        sentAt: 1_700_000_000_000,
        raw: {},
      },
      ctx,
    );
    expect(result.envelope?.chatId).toBe('parent-ch');
    expect(result.envelope?.threadId).toBe('thread-ch');
  });

  it('resolveChannelMode uses default when no override', () => {
    expect(resolveChannelMode('ch1', ctx)).toBe('mention_only');
  });

  it('stripMentions removes Discord mentions', () => {
    expect(stripMentions('<@123> hi').trim()).toBe('hi');
  });
});

// ---------------------------------------------------------------------------
// The channel-mode decision, end to end through triage (T4).
//
// `shouldRespond` (a boolean) is gone; triage now asks `evaluateChannelMode`
// in `@ethosagent/core` for a `{ shouldReply, shouldRecord }` pair, and the
// two answers can disagree. These drive `triageMessage` rather than the
// evaluator directly, so they also pin what triage does with each answer:
// drop only on `!shouldRecord`, and stamp `recordOnly: !shouldReply`.
// ---------------------------------------------------------------------------

function raw(overrides: Partial<RawDiscordMessage> = {}): RawDiscordMessage {
  return {
    channelId: 'ch1',
    userId: 'user1',
    text: 'site is flooded',
    messageId: 'msg1',
    isDm: false,
    isThread: false,
    isMention: false,
    sentAt: 1_700_000_000_000,
    raw: {},
    ...overrides,
  };
}

function ctxWith(mode: ChannelMode, threadState?: TriageContext['threadState']): TriageContext {
  return { botKey: 'test-bot', defaultChannelMode: mode, ...(threadState ? { threadState } : {}) };
}

describe('triageMessage — channel-mode decisions', () => {
  it('mention_only: unmentioned group message is neither answered nor recorded', async () => {
    const result = await triageMessage(raw(), ctxWith('mention_only'));
    expect(result.drop).toBe('channel_mode');
    expect(result.envelope).toBeUndefined();
  });

  it('mention_only: an @mention is answered', async () => {
    const result = await triageMessage(raw({ isMention: true }), ctxWith('mention_only'));
    expect(result.envelope?.recordOnly).toBe(false);
  });

  it('all: every group message is answered', async () => {
    const result = await triageMessage(raw(), ctxWith('all'));
    expect(result.envelope?.recordOnly).toBe(false);
  });

  // Real `ThreadStateStore`s, not structural stand-ins: the class carries
  // private fields, so a literal would need a cast past them.
  it('thread_follow: answered only once the bot has posted in the thread', async () => {
    const threaded = raw({ isThread: true, threadId: 't1', parentChannelId: 'ch1' });

    const silent = new ThreadStateStore(createInMemoryStorage(), 'discord', 'test-bot');
    await silent.load();
    expect((await triageMessage(threaded, ctxWith('thread_follow', silent))).drop).toBe(
      'channel_mode',
    );

    const posted = new ThreadStateStore(createInMemoryStorage(), 'discord', 'test-bot');
    await posted.recordPost('ch1', 't1');
    expect(
      (await triageMessage(threaded, ctxWith('thread_follow', posted))).envelope?.recordOnly,
    ).toBe(false);
  });

  it('observe: an unmentioned message is recorded, not answered', async () => {
    const result = await triageMessage(raw(), ctxWith('observe'));
    expect(result.drop).toBeUndefined();
    expect(result.envelope?.recordOnly).toBe(true);
    expect(result.envelope?.text).toBe('site is flooded');
  });

  // The product decision worth a test of its own: silence in an observed room
  // must not be conditional on what a third party types. A mention here is
  // recorded like anything else — it does NOT buy a reply.
  it('observe: an explicit @mention is still recorded and still not answered', async () => {
    const result = await triageMessage(raw({ isMention: true }), ctxWith('observe'));
    expect(result.envelope?.recordOnly).toBe(true);
  });

  it('observe: a DM to the bot is still a conversation, never record-only', async () => {
    const result = await triageMessage(raw({ isDm: true }), ctxWith('observe'));
    expect(result.envelope?.recordOnly).toBe(false);
  });

  it('carries the platform send time onto the envelope, not a clock reading', async () => {
    const result = await triageMessage(
      raw({ isMention: true, sentAt: 1_234_567_890_000 }),
      ctxWith('mention_only'),
    );
    expect(result.envelope?.sentAt).toBe(1_234_567_890_000);
  });
});
