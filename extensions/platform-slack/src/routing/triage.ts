// Translates a raw Slack event into an `InboundMessage` envelope and
// decides whether it reaches the agent. All Slack-specific decisions
// (channel-mode, thread isolation, mention extraction) live here.

import type { InboundMessage } from '@ethosagent/types';
import { type ChannelMode, DEFAULT_CHANNEL_MODE } from '../config';
import type { BackfillStateStore } from '../store/backfill-state';
import type { ChannelOverrideStore } from '../store/channel-overrides';
import type { ThreadStateStore } from '../store/thread-state';
import { shouldRespond } from './channel-mode';
import type { UsernameResolver } from './usernames';

/** What the adapter knows about itself + its persistent state. */
export interface TriageContext {
  botKey: string;
  defaultChannelMode: ChannelMode;
  channelOverrides?: ChannelOverrideStore;
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

  // app_mention has its own handler; the message handler is mention-blind.
  // shouldRespond gets isGroupMention=false here on purpose.
  const responds = shouldRespond({
    isDm,
    isGroupMention: false,
    channelMode,
    hasBotPosted,
  });

  if (!responds) return { drop: 'channel_mode', effectiveMode: channelMode };

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
      isDm,
      isGroupMention: false,
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
  // @mentions always reach the agent regardless of mode — the user is
  // explicitly addressing the bot.
  const text = stripMentions(evt.text).trim();
  if (!text) return { drop: 'no_text', effectiveMode: channelMode };

  return {
    envelope: buildEnvelope({
      botKey: ctx.botKey,
      channel: evt.channel,
      userId: evt.user,
      username: evt.user ? await ctx.users?.resolve(evt.user) : undefined,
      text,
      ts: evt.ts,
      threadTs: evt.thread_ts,
      isDm: false,
      isGroupMention: true,
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
  const override = ctx.channelOverrides?.get(channel);
  return override ?? ctx.defaultChannelMode ?? DEFAULT_CHANNEL_MODE;
}

interface EnvelopeInputs {
  botKey: string;
  channel: string;
  userId: string | undefined;
  username: string | undefined;
  text: string;
  ts: string | undefined;
  threadTs: string | undefined;
  isDm: boolean;
  isGroupMention: boolean;
  raw: unknown;
}

function buildEnvelope(input: EnvelopeInputs): InboundMessage {
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
    replyToId: input.threadTs,
    messageId: input.ts,
    ...(input.threadTs ? { threadId: input.threadTs } : {}),
    raw: input.raw,
  };
}

/** Remove every `<@USERID>` mention so the agent sees the plain message text. */
export function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, '');
}
