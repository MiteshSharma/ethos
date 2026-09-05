// Pure builder for the App Home tab. `(data) => View` — no Slack client, no
// I/O. The handler in `home/handlers.ts` gathers the data from the injected
// readers and publishes the result via `client.views.publish`.
//
// Sections, top to bottom:
//   - Header        — bot identity: display name, binding, status.
//   - Recent sessions — last N sessions, optionally deep-linked to the web UI.
//   - Active kanban — recently active tickets (team-bound bots only).
//   - Recent memory updates — last N MEMORY.md entries (bound personality).
//   - This bot is in — channels the bot is in + their channel mode, + Refresh.

import type { PendingClarify } from '@ethosagent/types';
import { HOME_RESTRICTED_TEXT } from '../authz';
import { clarifyHomeEntryBlocks } from '../blocks/clarify';
import { type KanbanTicket, kanbanListBlocks } from '../blocks/kanban';
import { type SessionSummary, sessionListBlocks } from '../blocks/session';
import {
  context,
  divider,
  escapeMrkdwn,
  header,
  type SlackBlock,
  section,
  truncate,
} from '../blocks/shared';
import type { Binding } from '../config';

/** `action_id` for the home tab's Refresh button. */
export const HOME_REFRESH_ACTION_ID = 'home:refresh';

// Per-section caps. Slack Home tab views have a hard 100-block limit; an
// unbounded reader (a bot in many channels, a busy team) would otherwise emit
// an invalid view. The caps are enforced here in the view builder, independent
// of what the readers return. Sessions/memory match the Phase 3 spec ("last 5
// sessions", "last 5 memory entries"); kanban/channels pick a sensible bound.
const SESSION_CAP = 5;
const MEMORY_CAP = 5;
const KANBAN_CAP = 10;
const CHANNEL_CAP = 20;
/** Pending clarifies cap. Each row contributes a question section + an
 *  actions block (≤25 elements). Five rows × 2 blocks = 10, well under
 *  Slack's 100-block view limit. */
const CLARIFY_CAP = 5;

// Per-field text caps. The count caps above bound the *number* of items; these
// bound the *length* of each model/config/user-influenced string before it's
// interpolated into a `section`/`context` text. Slack rejects a `views.publish`
// whose section text exceeds ~3000 chars, and `home/handlers.ts` swallows that
// failure into a blank Home tab — so every such field is capped here. The caps
// are deliberately well under 3000: even at the count cap, a section's total
// text stays comfortably within Slack's per-block limit.
//   - Memory snippets are whole MEMORY.md entries, so they get more room.
//   - Kanban titles share a `section` with status/assignee/id, so the title
//     cap leaves headroom for the rest of that line.
//   - Channel names are bounded in practice but capped defensively.
const MEMORY_SNIPPET_MAX = 500;
const KANBAN_TITLE_MAX = 300;
const CHANNEL_NAME_MAX = 100;

/** Truncate `items` to `cap`. Returns the kept slice and the overflow count
 *  so the caller can append an honest `+ N more` context row. */
function capSection<T>(items: T[], cap: number): { kept: T[]; overflow: number } {
  if (items.length <= cap) return { kept: items, overflow: 0 };
  return { kept: items.slice(0, cap), overflow: items.length - cap };
}

/** A Slack `view` payload — the shape `client.views.publish` expects. We use a
 *  minimal structural type for the same reason `blocks/` uses `SlackBlock`:
 *  this package doesn't take a direct `@slack/types` dependency. */
export interface SlackHomeView {
  type: 'home';
  blocks: SlackBlock[];
}

export interface HomeViewInput {
  bot: {
    /** The bot's Slack display name (from `auth.test`), or a fallback. */
    displayName: string;
    binding: Binding;
  };
  /** Recent sessions for this bot. Empty when the reader isn't wired. */
  sessions: SessionSummary[];
  /** Recently active kanban tickets. Empty when not a team bot / not wired. */
  kanbanTickets: KanbanTicket[];
  /** Last N MEMORY.md entries. Empty when the reader isn't wired. */
  memorySnippets: string[];
  /** Channels the bot is in, with their current mode. */
  /** Modes as stored — a value this build's enum cannot read is listed
   *  verbatim rather than hidden. */
  channelModes: Array<[string, string]>;
  /** Pending clarifies for this user — rendered above sessions as
   *  "Waiting on you" so the user can answer without hunting the channel.
   *  Optional for back-compat: when omitted the section is hidden. */
  pendingClarifies?: PendingClarify[];
  /** Ethos web UI origin (no trailing slash) for session deep links. */
  webUiBaseUrl?: string;
  /** Viewer is not on the bot's allowlist. The private sections (sessions,
   *  kanban, memory, channel roster) are replaced by a notice saying so —
   *  their empty states would otherwise read as "there is nothing here". */
  restricted?: boolean;
}

export function buildHomeView(input: HomeViewInput): SlackHomeView {
  const blocks: SlackBlock[] = [];

  // Header — bot identity.
  blocks.push(header(input.bot.displayName));
  const subject = input.bot.binding.type === 'team' ? 'team' : 'personality';
  blocks.push(
    section(
      `Bound to the *${subject}* \`${escapeMrkdwn(input.bot.binding.name)}\` · status *online*`,
    ),
  );
  blocks.push(divider());

  // Waiting on you — pending clarifies. Hidden entirely when there are none
  // so the section "earns" its existence rather than showing a tasteful
  // empty state on every load.
  const pending = input.pendingClarifies ?? [];
  if (pending.length > 0) {
    blocks.push(header('Waiting on you'));
    const clarifies = capSection(pending, CLARIFY_CAP);
    for (const row of clarifies.kept) {
      // Each row contributes its own question section + action buttons. The
      // App Home shares the same action_ids as the in-channel card, so a
      // click here resolves the same pending row.
      blocks.push(...clarifyHomeEntryBlocks(row));
    }
    if (clarifies.overflow > 0) blocks.push(context([`+ ${clarifies.overflow} more`]));
    blocks.push(divider());
  }

  // Restricted viewer — everything below this point is bot-private state, and
  // `app_home_opened` fires for any workspace member who opens the app. Say so
  // instead of rendering the sections' empty states, which would read as
  // "there is nothing here". "Waiting on you" above is already per-viewer.
  if (input.restricted) {
    blocks.push(section(HOME_RESTRICTED_TEXT));
    blocks.push(refreshActionsBlock());
    return { type: 'home', blocks };
  }

  // Recent sessions.
  const sessions = capSection(input.sessions, SESSION_CAP);
  blocks.push(...sessionListBlocks({ sessions: sessions.kept, webUiBaseUrl: input.webUiBaseUrl }));
  if (sessions.overflow > 0) blocks.push(context([`+ ${sessions.overflow} more`]));

  // Active kanban — team-bound bots only. Hidden entirely for personality bots
  // per the spec (kanban is a team feature).
  if (input.bot.binding.type === 'team') {
    const kanban = capSection(input.kanbanTickets, KANBAN_CAP);
    // `kanbanListBlocks` is shared with the `/ethos kanban` slash command, so
    // the per-field cap is applied here (App Home layer) on title-truncated
    // copies rather than in the builder.
    const tickets = kanban.kept.map((t) => ({
      ...t,
      title: truncate(t.title, KANBAN_TITLE_MAX),
    }));
    blocks.push(...kanbanListBlocks({ team: input.bot.binding.name, tickets }));
    if (kanban.overflow > 0) blocks.push(context([`+ ${kanban.overflow} more`]));
    blocks.push(divider());
  }

  // Recent memory updates.
  blocks.push(header('Recent memory updates'));
  const memory = capSection(input.memorySnippets, MEMORY_CAP);
  if (memory.kept.length === 0) {
    blocks.push(section('No recent memory updates.'));
  } else {
    for (const snippet of memory.kept) {
      blocks.push(section(escapeMrkdwn(truncate(snippet, MEMORY_SNIPPET_MAX))));
    }
    if (memory.overflow > 0) blocks.push(context([`+ ${memory.overflow} more`]));
  }
  blocks.push(divider());

  // This bot is in — channels + their mode.
  blocks.push(header('This bot is in'));
  const channels = capSection(input.channelModes, CHANNEL_CAP);
  if (channels.kept.length === 0) {
    blocks.push(section('This bot is not in any channels yet, or channel state is not persisted.'));
  } else {
    for (const [channel, mode] of channels.kept) {
      blocks.push(
        section(`<#${escapeMrkdwn(truncate(channel, CHANNEL_NAME_MAX))}> · mode \`${mode}\``),
      );
    }
    if (channels.overflow > 0) blocks.push(context([`+ ${channels.overflow} more`]));
  }
  blocks.push(refreshActionsBlock());

  return { type: 'home', blocks };
}

/** The Refresh button. Rendered on every view, restricted or not — a viewer
 *  who was just added to the allowlist re-publishes without leaving the tab. */
function refreshActionsBlock(): SlackBlock {
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        action_id: HOME_REFRESH_ACTION_ID,
        text: { type: 'plain_text', text: 'Refresh', emoji: true },
      },
    ],
  };
}
