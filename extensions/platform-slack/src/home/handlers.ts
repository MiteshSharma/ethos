// Bolt wiring for the App Home tab. Mirrors `events/messages.ts`:
// `registerHomeEvents(app, deps)` registers the `app_home_opened` event and the
// `home:refresh` action, both of which gather data from the injected readers
// and publish a freshly-built view via `client.views.publish`.
//
// The data-gathering is the only impure part; `buildHomeView` stays pure.
// Reader failures and `views.publish` failures are swallowed — Slack is the
// thing we don't control, and a bad event must never crash Bolt's event loop.

import type { PendingClarify } from '@ethosagent/types';
import type { App } from '@slack/bolt';
import { isUserAuthorized } from '../authz';
import type { KanbanTicket } from '../blocks/kanban';
import type { SessionSummary } from '../blocks/session';
import type { KanbanReader } from '../commands/kanban';
import type { MemoryReader } from '../commands/memory';
import { extractRecentEntries } from '../commands/memory';
import type { Binding } from '../config';
import { buildHomeView, HOME_REFRESH_ACTION_ID, type SlackHomeView } from './view';

/** Surface for pending clarifies — implemented by `SlackClarifySurface`.
 *  Optional on `HomeEventDeps`: when absent, the "Waiting on you" section
 *  is skipped entirely. The handler filters per user (anyone-clarify or
 *  this user is the originator). */
export interface ClarifyHomeReader {
  listPendingForBot(): Promise<PendingClarify[]>;
}

/** Minimal recent-session shape the home view consumes. The wiring layer
 *  adapts `SessionStore.listSessions` (filtered to this bot) to this surface
 *  so the Slack package never imports `@ethosagent/session-sqlite`. Optional
 *  on `SlackAdapterConfig` — when absent, the "Recent sessions" section shows
 *  a tasteful empty state, the same way `/ethos memory` degrades. */
export interface SessionReader {
  /** Most-recent sessions for this bot, newest first. The implementation
   *  decides the cap; the home view renders whatever it returns. */
  recentSessions(): Promise<SessionSummary[]>;
}

/** Read-only slice of `ChannelOverrideStore` the home view needs. The shared
 *  store (`@ethosagent/core`) indexes `{ mode, regexPattern? }`, where Slack's
 *  own copy indexed a bare mode; the home view still wants channel→mode, so
 *  the shape is narrowed once here rather than in the view. */
interface ChannelModeSource {
  entries(): Array<[string, { mode: string }]>;
}

export interface HomeEventDeps {
  binding: Binding;
  /** The bot's Slack display name, resolved from `auth.test` at startup. */
  displayName: string;
  channelOverrides: ChannelModeSource | undefined;
  session: SessionReader | undefined;
  memory: MemoryReader | undefined;
  kanban: KanbanReader | undefined;
  /** Source of pending clarifies for the "Waiting on you" section. Absent
   *  when the surface isn't wired, in which case the section is hidden. */
  clarify?: ClarifyHomeReader;
  /** Ethos web UI origin for session deep links. Links render only when set. */
  webUiBaseUrl?: string;
  /**
   * Slack user IDs allowed to see this bot's private state. Everything the
   * Home tab renders below the header — MEMORY.md entries, session labels,
   * the kanban board, the channel roster — is bot-private, and
   * `app_home_opened` fires for any workspace member who clicks the app.
   * Default-deny: unset or empty hides every one of those sections. Pending
   * clarifies are exempt because they are already filtered to the viewer.
   */
  allowedUsers?: string[];
}

/** Number of MEMORY.md entries surfaced in the home tab. */
const MEMORY_SNIPPET_COUNT = 5;

/** The one Bolt `client` capability the home handlers use. We narrow the Bolt
 *  client to this at the call site for the same reason `blocks/` uses
 *  `SlackBlock` — keep the single method we call type-checked without taking a
 *  direct `@slack/web-api` dependency. */
type HomeClient = {
  views: { publish: (args: { user_id: string; view: SlackHomeView }) => Promise<unknown> };
};

export function registerHomeEvents(app: App, deps: HomeEventDeps): void {
  const publishHome = async (client: HomeClient, userId: string): Promise<void> => {
    const authorized = isUserAuthorized(userId, deps.allowedUsers);
    const [sessions, kanbanTickets, memorySnippets, pendingClarifies] = await Promise.all([
      gatherSessions(deps, userId),
      gatherKanban(deps, userId),
      gatherMemory(deps, userId),
      gatherPendingClarifies(deps, userId),
    ]);
    // `buildHomeView` is pure first-party code — a bug here should surface via
    // Bolt's error handling, not be swallowed below into a blank Home tab.
    const view = buildHomeView({
      bot: { displayName: deps.displayName, binding: deps.binding },
      sessions,
      kanbanTickets,
      memorySnippets,
      channelModes: authorized
        ? (deps.channelOverrides
            ?.entries()
            .map(([channel, { mode }]) => [channel, mode] as const) ?? [])
        : [],
      pendingClarifies,
      webUiBaseUrl: deps.webUiBaseUrl,
      restricted: !authorized,
    });
    try {
      await client.views.publish({ user_id: userId, view });
    } catch {
      // Slack is the one thing we don't control — a `views.publish` failure or
      // Bolt API drift must not throw inside the event loop.
    }
  };

  app.event('app_home_opened', async ({ event, client }) => {
    const evt = event as { user?: string; tab?: string };
    // `app_home_opened` also fires for the Messages tab — only the Home tab
    // has a view to publish. A missing `tab` falls through and publishes: the
    // real Slack event always carries `tab`, so absence means a malformed
    // payload, and a Home publish is the safe default.
    if (evt.tab && evt.tab !== 'home') return;
    if (!evt.user) return;
    await publishHome(client as HomeClient, evt.user);
  });

  app.action(HOME_REFRESH_ACTION_ID, async ({ ack, body, client }) => {
    await ack();
    const userId = (body as { user?: { id?: string } }).user?.id;
    if (!userId) return;
    await publishHome(client as HomeClient, userId);
  });
}

/** Gather recent sessions for an allowlisted viewer, tolerating a missing or
 *  throwing reader. A non-allowlisted viewer gets `[]` — and no read. */
async function gatherSessions(deps: HomeEventDeps, userId: string): Promise<SessionSummary[]> {
  if (!deps.session || !isUserAuthorized(userId, deps.allowedUsers)) return [];
  try {
    return await deps.session.recentSessions();
  } catch {
    return [];
  }
}

/** Gather kanban tickets — only for team bots and allowlisted viewers,
 *  tolerating reader failure. */
async function gatherKanban(deps: HomeEventDeps, userId: string): Promise<KanbanTicket[]> {
  if (deps.binding.type !== 'team' || !deps.kanban) return [];
  if (!isUserAuthorized(userId, deps.allowedUsers)) return [];
  try {
    return await deps.kanban.listOpenTickets();
  } catch {
    return [];
  }
}

/** Gather the last N MEMORY.md entries for an allowlisted viewer, tolerating
 *  reader failure. Memory is the same trusted text the system prompt is built
 *  from, so a non-allowlisted viewer gets `[]` and MEMORY.md is never read. */
async function gatherMemory(deps: HomeEventDeps, userId: string): Promise<string[]> {
  if (!deps.memory || !isUserAuthorized(userId, deps.allowedUsers)) return [];
  try {
    const body = await deps.memory.read();
    return extractRecentEntries(body, MEMORY_SNIPPET_COUNT);
  } catch {
    return [];
  }
}

/** Gather pending clarifies the given user can answer — anyone-clarify or
 *  this user is the originator. Tolerant of reader failure (returns []). */
async function gatherPendingClarifies(
  deps: HomeEventDeps,
  userId: string,
): Promise<PendingClarify[]> {
  if (!deps.clarify) return [];
  try {
    const all = await deps.clarify.listPendingForBot();
    return all.filter(
      (r) => r.answerableBy === 'anyone' || r.surfaceContext.originatorUserId === userId,
    );
  } catch {
    return [];
  }
}
