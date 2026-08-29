// Pure slash-command dispatcher. The Bolt adapter calls `dispatch()` with
// the parsed slash command payload; this module decides which subcommand
// runs and returns a structured response. Decoupling Bolt from the
// dispatch logic lets us unit-test subcommands without standing up a real
// Slack app.

import type { Storage } from '@ethosagent/types';
import { isUserAuthorized, SLASH_DENIED_TEXT } from '../authz';
import { type SlackBlock, section } from '../blocks/shared';
import type { Binding, ChannelMode } from '../config';
import type { ChannelOverrideStore } from '../store/channel-overrides';
import { handleAsk } from './ask';
import { handleChannelMode } from './channel-mode';
import { handleHelp } from './help';
import { handleKanban, type KanbanReader } from './kanban';
import { handleMemory, type MemoryReader } from './memory';
import { handlePersonality, type PersonalityCardReader } from './personality';

/** Slack slash-command payload subset we consume. */
export interface SlashCommandPayload {
  command: string; // e.g. '/ethos'
  text: string; // everything after the command — subcommand + args
  channel_id: string;
  user_id: string;
  trigger_id: string;
}

/** Inputs every subcommand needs. Built by the adapter from its own state. */
export interface SlashContext {
  binding: Binding;
  defaultChannelMode: ChannelMode;
  channelOverrides?: ChannelOverrideStore;
  memory?: MemoryReader;
  kanban?: KanbanReader;
  personalityCard?: PersonalityCardReader;
  /** Storage is exposed for sub-commands that persist their own state. */
  storage?: Storage;
  /** Hook for `/ethos ask` — the adapter wires this to gateway.handleMessage. */
  submitAgentTurn?: (input: { channel: string; user: string; text: string }) => Promise<void>;
  /**
   * Allowlist of Slack user IDs permitted to run slash commands. Only these
   * users may invoke `/ethos`; everyone else receives an ephemeral "not
   * authorized" response. Default-deny: when unset or empty, nobody is
   * authorized — `/ethos memory add` writes into the system prompt and
   * `/ethos channel-mode` rewrites routing, so an open default is a hole,
   * not a compatibility affordance.
   */
  allowedUsers?: string[];
  /** CHS-005 — optional sink so a refusal is recorded, not just displayed. */
  observability?: {
    recordSafetyBlock(opts: {
      code?: string;
      cause?: string;
      details?: Record<string, unknown>;
    }): void;
  };
}

export interface SlashResponse {
  /** Block Kit blocks for the rendered reply. */
  blocks: SlackBlock[];
  /** Plain-text fallback used in notifications and screen-readers. */
  text: string;
  /** `ephemeral` shows only to the invoker; `in_channel` posts publicly. */
  responseType: 'ephemeral' | 'in_channel';
}

const SUBCOMMANDS = ['ask', 'personality', 'memory', 'kanban', 'channel-mode', 'help'] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export function parseSubcommand(text: string): { name: Subcommand | 'unknown'; rest: string } {
  const trimmed = text.trim();
  if (!trimmed) return { name: 'help', rest: '' };
  const [first, ...restParts] = trimmed.split(/\s+/);
  const candidate = first.toLowerCase();
  const known = SUBCOMMANDS.find((s) => s === candidate);
  if (!known) return { name: 'unknown', rest: trimmed };
  return { name: known, rest: restParts.join(' ') };
}

export async function dispatch(
  payload: SlashCommandPayload,
  ctx: SlashContext,
): Promise<SlashResponse> {
  // Authorization first, before the payload is parsed: every subcommand below
  // either reads bot-private state or mutates it, so the gate is the whole
  // surface, not a per-subcommand decision.
  if (!isUserAuthorized(payload.user_id, ctx.allowedUsers)) {
    // CHS-005 — the refusal is the whole security control for this surface, so
    // it lands in the audit trail rather than only on the caller's screen.
    ctx.observability?.recordSafetyBlock({
      code: 'slack.slash.unauthorized',
      cause: 'user not in allowedUsers',
      details: { userId: payload.user_id, channelId: payload.channel_id },
    });
    const blocks = [section(SLASH_DENIED_TEXT)];
    return { blocks, text: SLASH_DENIED_TEXT, responseType: 'ephemeral' };
  }

  const { name, rest } = parseSubcommand(payload.text);

  switch (name) {
    case 'ask':
      return handleAsk(payload, rest, ctx);
    case 'personality':
      return handlePersonality(rest, ctx);
    case 'memory':
      return handleMemory(rest, ctx);
    case 'kanban':
      return handleKanban(ctx);
    case 'channel-mode':
      return handleChannelMode(payload.channel_id, rest, ctx);
    case 'help':
      return handleHelp(payload.channel_id, ctx);
    case 'unknown': {
      const { unknownSubcommandResponse } = await import('./help');
      return unknownSubcommandResponse(rest, ctx, payload.channel_id);
    }
  }
}

export type { KanbanReader, MemoryReader, PersonalityCardReader };
