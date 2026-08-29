// Bridges Slack message + app_mention events to the adapter's
// `messageHandler` callback (which the gateway hooks into via
// `adapter.onMessage()`). All Slack-specific decisions live in
// `routing/triage`; this file just wires Bolt up to it.

import type { InboundMessage, PriorContextEntry } from '@ethosagent/types';
import type { App, MessageEvent } from '@slack/bolt';
import {
  isAllowedBotId,
  type RawSlackMention,
  type RawSlackMessage,
  type TriageContext,
  triageMention,
  triageMessage,
} from '../routing/triage';
import type { UsernameResolver } from '../routing/usernames';

export interface MessageEventHandlers {
  onEnvelope(message: InboundMessage): void;
}

const BACKFILL_FETCH_LIMIT = 50;
const BACKFILL_INCLUDE_LIMIT = 40;
const BACKFILL_CHAR_LIMIT = 4000;

/** Debounce window (ms) for `message_changed` events. Rapid successive
 *  edits to the same message collapse into a single inbound envelope. */
const EDIT_DEBOUNCE_MS = 200;

interface HistoryMessage {
  text?: string;
  user?: string;
  username?: string;
  subtype?: string;
  bot_id?: string;
  bot_profile?: { name?: string };
}

/** History line author, in the order Slack makes the name available: the
 *  resolved display name, then the name a bot post carries itself, then the
 *  raw id as a last resort. */
function historyAuthor(msg: HistoryMessage, names: Map<string, string>): string {
  const resolved = msg.user ? names.get(msg.user) : undefined;
  return resolved ?? msg.username ?? msg.bot_profile?.name ?? msg.user ?? 'unknown';
}

/** Backfilled history plus the per-line attribution the channel filter needs. */
interface SlackHistory {
  text: string;
  entries: PriorContextEntry[];
}

async function fetchSlackHistory(
  client: App['client'],
  channelId: string,
  threadTs: string | undefined,
  triggeringTs: string | undefined,
  allowedBotIds: string[] | undefined,
  users: UsernameResolver | undefined,
): Promise<SlackHistory | undefined> {
  try {
    let messages: HistoryMessage[];
    if (threadTs) {
      const res = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: BACKFILL_FETCH_LIMIT,
      });
      messages = (res.messages ?? []) as typeof messages;
      if (triggeringTs) {
        messages = messages.filter((m) => (m as { ts?: string }).ts !== triggeringTs);
      }
    } else {
      const res = await client.conversations.history({
        channel: channelId,
        limit: BACKFILL_FETCH_LIMIT,
        ...(triggeringTs ? { latest: triggeringTs, inclusive: false } : {}),
      });
      messages = (res.messages ?? []) as typeof messages;
    }

    const included = messages
      .filter((m) => {
        if (!m.text?.trim()) return false;
        // Allowlisted bots contribute to history; every other bot stays out.
        if (isAllowedBotId(m.bot_id, allowedBotIds)) return true;
        return !m.bot_id && m.subtype !== 'bot_message';
      })
      .reverse()
      .slice(-BACKFILL_INCLUDE_LIMIT);

    // One batch for the whole thread: the resolver collapses duplicate ids and
    // serves repeat authors from its cache, so a 40-message thread from three
    // people costs three `users.info` calls, not forty.
    const authorIds = included.map((m) => m.user).filter((u): u is string => Boolean(u));
    const names = users ? await users.resolveMany(authorIds) : new Map<string, string>();

    // `userId` is the id the gateway's channel filter allowlists by, so it has
    // to match what `triageMessage` stamps on a live envelope: a human's
    // `user`, an allowlisted bot's `bot_id`.
    const entries: PriorContextEntry[] = included.map((m) => ({
      userId: m.bot_id ?? m.user,
      text: `${historyAuthor(m, names)}: ${m.text?.trim()}`,
    }));

    const { kept, omitted } = capHistory(entries);
    const lines = kept.map((e) => e.text).join('\n');
    if (!lines) return undefined;

    const trimmed = omitted ? `[... earlier messages omitted]\n${lines}` : lines;
    const label = threadTs ? 'thread history' : 'channel history';
    return { text: `[Recent ${label} — before bot joined]\n\n${trimmed}`, entries: kept };
  } catch {
    return undefined;
  }
}

/**
 * Trim the history to `BACKFILL_CHAR_LIMIT`, newest first, dropping whole
 * entries rather than slicing mid-line — the rendered text and the entries
 * have to stay byte-identical or the channel filter cannot rebuild one from
 * the other.
 *
 * Duplicated in `platform-discord/src/events/messages.ts` — the two adapter
 * packages cannot import each other, and the backfill constants beside it are
 * already duplicated for the same reason.
 */
function capHistory(entries: PriorContextEntry[]): {
  kept: PriorContextEntry[];
  omitted: boolean;
} {
  const kept: PriorContextEntry[] = [];
  let budget = BACKFILL_CHAR_LIMIT;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const cost = entry.text.length + (kept.length > 0 ? 1 : 0);
    if (cost > budget) {
      // A single line wider than the whole budget still gets a tail slice —
      // otherwise one long message would evade the cap entirely.
      if (kept.length === 0) kept.push({ ...entry, text: entry.text.slice(-BACKFILL_CHAR_LIMIT) });
      return { kept, omitted: true };
    }
    budget -= cost;
    kept.unshift(entry);
  }
  return { kept, omitted: false };
}

export function registerMessageEvents(
  app: App,
  triage: TriageContext,
  handlers: MessageEventHandlers,
): void {
  /** Pending debounce timers for edited messages, keyed by
   *  `${channelId}:${messageTs}`. */
  const editTimers = new Map<string, ReturnType<typeof setTimeout>>();

  app.message(async ({ message }) => {
    const raw = message as MessageEvent;
    const triggeringTs = (raw as unknown as { ts?: string }).ts;

    // `message_changed` subtype: the actual content lives in `event.message`,
    // not at the top level. We debounce rapid successive edits (200 ms) so
    // the agent doesn't process two envelopes for a quick typo-fix cycle.
    if (raw.subtype === 'message_changed') {
      const rawObj = raw as unknown as Record<string, unknown>;
      const inner = rawObj.message as Record<string, unknown> | undefined;
      if (!inner) return;

      // Reject edited bot messages to prevent feedback loops, unless the
      // operator has allowlisted this bot's `bot_id`.
      const innerBotId = inner.bot_id as string | undefined;
      if ((innerBotId || inner.bot_profile) && !isAllowedBotId(innerBotId, triage.allowedBotIds))
        return;

      const channel = rawObj.channel as string | undefined;
      if (!channel) return;

      const ts = inner.ts as string | undefined;
      if (!ts) return;

      const key = `${channel}:${ts}`;

      // Clear any pending timer for the same message — the latest edit wins.
      const existing = editTimers.get(key);
      if (existing !== undefined) clearTimeout(existing);

      const timer = setTimeout(() => {
        editTimers.delete(key);

        const syntheticMsg: RawSlackMessage = {
          channel,
          user: inner.user as string | undefined,
          text: inner.text as string | undefined,
          ts,
          thread_ts: inner.thread_ts as string | undefined,
          channel_type: rawObj.channel_type as string | undefined,
          subtype: inner.subtype as string | undefined,
          files: inner.files as RawSlackMessage['files'],
          ...(innerBotId ? { bot_id: innerBotId } : {}),
          // Bot posts name themselves; a human's name comes from `users.info`.
          username: inner.username as string | undefined,
          bot_profile: inner.bot_profile as { name?: string } | undefined,
        };

        if (inner.parent_user_id) syntheticMsg.parent_user_id = inner.parent_user_id as string;

        void triageMessage(syntheticMsg, triage)
          .then((result) => {
            if (result.envelope) {
              handlers.onEnvelope({ ...result.envelope, isEdit: true });
            }
          })
          .catch(() => {
            // Best-effort — matches adapter error policy for normal messages
          });
      }, EDIT_DEBOUNCE_MS);

      editTimers.set(key, timer);
      return;
    }

    const result = await triageMessage(raw as unknown as RawSlackMessage, triage);
    if (result.envelope && triage.backfillState) {
      const channelId = result.envelope.chatId;
      const threadTs = result.envelope.threadId;
      if (threadTs && !triage.backfillState.hasDone(channelId, threadTs)) {
        const history = await fetchSlackHistory(
          app.client,
          channelId,
          threadTs,
          triggeringTs,
          triage.allowedBotIds,
          triage.users,
        );
        await triage.backfillState.mark(channelId, threadTs);
        if (history) {
          result.envelope.priorContext = history.text;
          result.envelope.priorContextEntries = history.entries;
        }
      }
    }
    if (result.envelope) handlers.onEnvelope(result.envelope);
  });

  app.event('app_mention', async ({ event }) => {
    const triggeringTs = (event as unknown as { ts?: string }).ts;
    const result = await triageMention(event as unknown as RawSlackMention, triage);
    if (result.envelope && triage.backfillState) {
      const channelId = result.envelope.chatId;
      const threadTs = result.envelope.threadId;
      if (threadTs && !triage.backfillState.hasDone(channelId, threadTs)) {
        const history = await fetchSlackHistory(
          app.client,
          channelId,
          threadTs,
          triggeringTs,
          triage.allowedBotIds,
          triage.users,
        );
        await triage.backfillState.mark(channelId, threadTs);
        if (history) {
          result.envelope.priorContext = history.text;
          result.envelope.priorContextEntries = history.entries;
        }
      }
    }
    if (result.envelope) handlers.onEnvelope(result.envelope);
  });
}
