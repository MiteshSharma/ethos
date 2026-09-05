// Translates a raw Slack event into an `InboundMessage` envelope and
// decides whether it reaches the agent. All Slack-specific decisions
// (channel-mode, thread isolation, mention extraction) live here.

import type { ChannelOverrideStore } from '@ethosagent/core';
import { evaluateChannelMode } from '@ethosagent/core';
import type { InboundMessage } from '@ethosagent/types';
import { type ChannelMode, DEFAULT_CHANNEL_MODE } from '../config';
import type { BackfillStateStore } from '../store/backfill-state';
import type { ThreadStateStore } from '../store/thread-state';
import type { UsernameResolver } from './usernames';

/** What the adapter knows about itself + its persistent state. */
export interface TriageContext {
  botKey: string;
  defaultChannelMode: ChannelMode;
  channelOverrides?: ChannelOverrideStore<ChannelMode>;
  threadState?: ThreadStateStore;
  backfillState?: BackfillStateStore;
  /** Slack `bot_id`s whose messages are allowed to reach the agent. Absent or
   *  empty denies every bot — the gate is default-closed. */
  allowedBotIds?: string[];
  /** `users.info` display-name resolver. Absent (or unable to resolve) leaves
   *  `InboundMessage.username` unset. */
  users?: UsernameResolver;
}

/**
 * Default-closed allowlist test for bot-authored messages. An absent or empty
 * list denies every bot, which is the behaviour before the allowlist existed.
 */
export function isAllowedBotId(
  botId: string | undefined,
  allowedBotIds: string[] | undefined,
): boolean {
  if (!botId || !allowedBotIds || allowedBotIds.length === 0) return false;
  return allowedBotIds.includes(botId);
}

/** Subset of a Slack file object attached to a `file_share` message. */
export interface RawSlackFile {
  name?: string;
  filetype?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
}

export interface RawSlackMessage {
  channel: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel_type?: string;
  subtype?: string;
  files?: RawSlackFile[];
  /** Author of the thread parent, stamped by Slack on every threaded reply. */
  parent_user_id?: string;
  /** Present on messages authored by an app/workflow rather than a human. */
  bot_id?: string;
  /** Display name Slack stamps on bot/workflow posts. Humans don't carry it. */
  username?: string;
  /** Richer bot identity on newer bot posts; `username` is the older field. */
  bot_profile?: { name?: string };
}

/** Subset of the Slack `app_mention` event we actually consume. */
export interface RawSlackMention {
  channel: string;
  user?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  /** Author of the thread parent; present when the mention is a thread reply. */
  parent_user_id?: string;
}

export interface TriageResult {
  /** Built envelope; only present when the message reaches the agent. */
  envelope?: InboundMessage;
  /** Reason for dropping; surfaced in logs when present. */
  drop?: 'no_text' | 'channel_mode' | 'subtype';
  /** Effective channel mode after overrides — surfaced for diagnostics. */
  effectiveMode: ChannelMode;
}

export async function triageMessage(
  msg: RawSlackMessage,
  ctx: TriageContext,
): Promise<TriageResult> {
  const channelMode = resolveChannelMode(msg.channel, ctx);

  // Bot/workflow posts arrive as `subtype: 'bot_message'`. They reach the
  // agent only when the operator has allowlisted their `bot_id`.
  const allowedBot = isAllowedBotId(msg.bot_id, ctx.allowedBotIds);
  if (msg.subtype && msg.subtype !== 'file_share' && !(msg.subtype === 'bot_message' && allowedBot))
    return { drop: 'subtype', effectiveMode: channelMode };
  const text = msg.text?.trim() ?? '';
  const hasFiles = msg.subtype === 'file_share' && Array.isArray(msg.files) && msg.files.length > 0;
  if (!text && !hasFiles) return { drop: 'no_text', effectiveMode: channelMode };

  const isDm = msg.channel_type === 'im';
  const threadTs = msg.thread_ts;
  const hasBotPosted =
    threadTs && ctx.threadState ? ctx.threadState.hasBotPosted(msg.channel, threadTs) : false;

  // The one shared decision (`@ethosagent/core`), not a Slack-local matrix.
  // Note what it can now answer that a boolean could not: `observe` says do
  // NOT reply but DO record.
  //
  // app_mention has its own handler; the message handler is mention-blind, so
  // `isGroupMention` is false here on purpose.
  const decision = evaluateChannelMode({
    isDm,
    isGroupMention: false,
    channelMode,
    hasBotPosted,
  });

  // Only a message that is neither answered nor recorded is dropped here.
  if (!decision.shouldRecord) return { drop: 'channel_mode', effectiveMode: channelMode };

  return {
    envelope: buildEnvelope({
      botKey: ctx.botKey,
      channel: msg.channel,
      // An allowlisted bot has no `user`; stamping the `bot_id` gives it an
      // identity the gateway's channel filter can allowlist by (it keys on
      // `userId`). Two gates, both must open.
      userId: allowedBot ? msg.bot_id : msg.user,
      username: await resolveSenderName(msg, allowedBot, ctx),
      text: text || (hasFiles ? '(file attachment)' : ''),
      ts: msg.ts,
      threadTs,
      parentUserId: msg.parent_user_id,
      isDm,
      isGroupMention: false,
      // Recorded, not answered. The gateway reads this flag, writes the
      // transcript row and returns before the channel filter ever runs.
      recordOnly: !decision.shouldReply,
      raw: msg,
    }),
    effectiveMode: channelMode,
  };
}

export async function triageMention(
  evt: RawSlackMention,
  ctx: TriageContext,
): Promise<TriageResult> {
  const channelMode = resolveChannelMode(evt.channel, ctx);
  const text = stripMentions(evt.text).trim();
  if (!text) return { drop: 'no_text', effectiveMode: channelMode };

  // An @mention reaches the agent under every mode EXCEPT `observe` — the user
  // is explicitly addressing the bot, and the mode only decides whether the
  // bot is allowed to answer out loud. There is deliberately no drop branch
  // here: with `isGroupMention: true` the shared evaluator engages for every
  // mode it knows and for every mode it does not, and observes for `observe`,
  // so `shouldRecord` is true in all of them. What the mode changes is
  // `recordOnly` — silence in an observed channel must not be conditional on
  // what a third party types.
  const decision = evaluateChannelMode({
    isDm: false,
    isGroupMention: true,
    channelMode,
  });

  return {
    envelope: buildEnvelope({
      botKey: ctx.botKey,
      channel: evt.channel,
      userId: evt.user,
      username: evt.user ? await ctx.users?.resolve(evt.user) : undefined,
      text,
      ts: evt.ts,
      threadTs: evt.thread_ts,
      parentUserId: evt.parent_user_id,
      isDm: false,
      isGroupMention: true,
      recordOnly: !decision.shouldReply,
      raw: evt,
    }),
    effectiveMode: channelMode,
  };
}

/**
 * Human-readable sender name for the envelope. Telegram's analogue is
 * `ctx.from?.username` — the handle the platform shows, left `undefined` when
 * the platform doesn't have one. Slack's equivalent needs a `users.info` call.
 *
 * An allowlisted bot has no `user` for `users.info` to resolve, but Slack
 * stamps the app's own name onto the payload, so we read it from there.
 */
async function resolveSenderName(
  msg: RawSlackMessage,
  allowedBot: boolean,
  ctx: TriageContext,
): Promise<string | undefined> {
  if (allowedBot) return msg.username ?? msg.bot_profile?.name;
  if (!msg.user) return undefined;
  return ctx.users?.resolve(msg.user);
}

export function resolveChannelMode(channel: string, ctx: TriageContext): ChannelMode {
  // `.mode` — the shared store indexes `{ mode, regexPattern? }`, where
  // Slack's own copy indexed a bare mode.
  const override = ctx.channelOverrides?.get(channel);
  return override?.mode ?? ctx.defaultChannelMode ?? DEFAULT_CHANNEL_MODE;
}

interface EnvelopeInputs {
  botKey: string;
  channel: string;
  userId: string | undefined;
  username: string | undefined;
  text: string;
  ts: string | undefined;
  threadTs: string | undefined;
  parentUserId: string | undefined;
  isDm: boolean;
  isGroupMention: boolean;
  recordOnly: boolean;
  raw: unknown;
}

/**
 * Slack's `ts` is the message's send time as a string of SECONDS with a
 * fractional part (`'1699000000.123456'`) — it doubles as the message id, so
 * the fraction is a uniquifier rather than sub-millisecond precision. Scale to
 * the epoch-milliseconds `InboundMessage.sentAt` is specified in and round;
 * `1699000000.123456 * 1000` is `1699000000123.456`, and the transcript orders
 * by whole milliseconds.
 *
 * Absent or unparseable `ts` leaves `sentAt` unset, which the contract says
 * means "this adapter has no platform timestamp" — better than a NaN or a
 * clock reading dressed up as a platform time.
 */
export function tsToSentAt(ts: string | undefined): number | undefined {
  if (!ts) return undefined;
  const seconds = Number(ts);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined;
}

function buildEnvelope(input: EnvelopeInputs): InboundMessage {
  const sentAt = tsToSentAt(input.ts);
  // Top-level channel posts deliberately leave `threadId` undefined — the
  // gateway then routes to the unthreaded `${platform}:${botKey}:${chatId}`
  // lane. Threaded posts set `threadId = thread_ts` for per-thread isolation.
  // No sentinel value: keeping `'top'` (or any platform-specific string) on
  // the generic `InboundMessage` contract would leak Slack's lane policy
  // into every future adapter.
  return {
    platform: 'slack',
    botKey: input.botKey,
    chatId: input.channel,
    userId: input.userId,
    username: input.username,
    text: input.text,
    isDm: input.isDm,
    isGroupMention: input.isGroupMention,
    // Slack has no per-message quote-reply; the thread parent is the message
    // this one replies to. `parent_user_id` is Slack's own field for its
    // author and rides on the event, so no extra API call is needed. Absent
    // on top-level posts (there is no parent) — and the channel filter's
    // step 7a reads `replyToUserId === undefined` as "adapter can't say".
    replyToId: input.threadTs,
    replyToUserId: input.parentUserId,
    messageId: input.ts,
    ...(input.threadTs ? { threadId: input.threadTs } : {}),
    recordOnly: input.recordOnly,
    // Slack's own send time, not the time we received it: a message delayed in
    // transit still orders by when it was sent.
    ...(sentAt !== undefined ? { sentAt } : {}),
    raw: input.raw,
  };
}

/** Remove every `<@USERID>` mention so the agent sees the plain message text. */
export function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, '');
}
