// Translates a raw Discord event into an `InboundMessage` envelope and
// decides whether it reaches the agent. All Discord-specific decisions
// (channel-mode, thread isolation, mention extraction) live here.

import type { ChannelOverrideStore } from '@ethosagent/core';
import { evaluateChannelMode } from '@ethosagent/core';
import type { InboundMessage } from '@ethosagent/types';
import { type ChannelMode, DEFAULT_CHANNEL_MODE } from '../config';
import type { ThreadStateStore } from '../store/thread-state';

/** What the adapter knows about itself + its persistent state. */
export interface TriageContext {
  botKey: string;
  defaultChannelMode: ChannelMode;
  channelOverrides?: ChannelOverrideStore<ChannelMode>;
  threadState?: ThreadStateStore;
}

export interface RawDiscordMessage {
  channelId: string;
  userId: string;
  username?: string;
  text: string;
  messageId: string;
  isDm: boolean;
  isThread: boolean;
  threadId?: string;
  parentChannelId?: string;
  isMention: boolean;
  reference?: { messageId?: string; userId?: string };
  /** Platform send time (ms) — `Message.createdTimestamp`. Orders the transcript. */
  sentAt: number;
  raw: unknown;
}

export interface TriageResult {
  /** Built envelope; only present when the message reaches the agent. */
  envelope?: InboundMessage;
  /** Reason for dropping; surfaced in logs when present. */
  drop?: 'no_text' | 'channel_mode';
  /** Effective channel mode after overrides — surfaced for diagnostics. */
  effectiveMode: ChannelMode;
}

export async function triageMessage(
  msg: RawDiscordMessage,
  ctx: TriageContext,
): Promise<TriageResult> {
  const chatId = msg.isThread ? (msg.parentChannelId ?? msg.channelId) : msg.channelId;
  const channelMode = resolveChannelMode(chatId, ctx);

  const text = msg.isMention ? stripMentions(msg.text).trim() : msg.text.trim();
  if (!text) return { drop: 'no_text', effectiveMode: channelMode };

  const threadId = msg.isThread ? msg.threadId : undefined;
  const hasBotPosted =
    threadId && ctx.threadState ? ctx.threadState.hasBotPosted(chatId, threadId) : false;

  // The one shared decision (`@ethosagent/core`), not a Discord-local matrix.
  // Note what it can now answer that a boolean could not: `observe` says do
  // NOT reply but DO record.
  const decision = evaluateChannelMode({
    isDm: msg.isDm,
    isGroupMention: msg.isMention,
    channelMode,
    hasBotPosted,
  });

  // Only a message that is neither answered nor recorded is dropped here.
  if (!decision.shouldRecord) return { drop: 'channel_mode', effectiveMode: channelMode };

  return {
    envelope: buildEnvelope({
      botKey: ctx.botKey,
      chatId,
      userId: msg.userId,
      username: msg.username,
      text,
      messageId: msg.messageId,
      threadId,
      isDm: msg.isDm,
      isGroupMention: msg.isMention,
      replyToId: msg.reference?.messageId,
      replyToUserId: msg.reference?.userId,
      // Recorded, not answered. The gateway reads this flag, writes the
      // transcript row and returns before the channel filter ever runs.
      recordOnly: !decision.shouldReply,
      sentAt: msg.sentAt,
      raw: msg.raw,
    }),
    effectiveMode: channelMode,
  };
}

export function resolveChannelMode(channel: string, ctx: TriageContext): ChannelMode {
  // `.mode` — the shared store indexes `{ mode, regexPattern? }`, where
  // Discord's own copy indexed a bare mode.
  const override = ctx.channelOverrides?.get(channel);
  return override?.mode ?? ctx.defaultChannelMode ?? DEFAULT_CHANNEL_MODE;
}

interface EnvelopeInputs {
  botKey: string;
  chatId: string;
  userId: string;
  username?: string;
  text: string;
  messageId: string;
  threadId: string | undefined;
  isDm: boolean;
  isGroupMention: boolean;
  replyToId?: string;
  replyToUserId?: string;
  recordOnly: boolean;
  sentAt: number;
  raw: unknown;
}

function buildEnvelope(input: EnvelopeInputs): InboundMessage {
  return {
    platform: 'discord',
    botKey: input.botKey,
    chatId: input.chatId,
    userId: input.userId,
    username: input.username,
    text: input.text,
    replyToId: input.replyToId,
    replyToUserId: input.replyToUserId,
    isDm: input.isDm,
    isGroupMention: input.isGroupMention,
    messageId: input.messageId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    recordOnly: input.recordOnly,
    sentAt: input.sentAt,
    raw: input.raw,
  };
}

/** Remove every `<@USERID>` mention so the agent sees the plain message text. */
export function stripMentions(text: string): string {
  return text.replace(/<@[A-Za-z0-9!&]+>/g, '');
}
