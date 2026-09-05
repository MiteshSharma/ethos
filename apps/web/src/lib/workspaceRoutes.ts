// Pure URL-resolution logic for P1a (plan/phases/personality-first-ui.md) —
// the routing-only phase that moves eleven workspace pages under
// `/p/:personalityId/…` and turns every old URL into a permanent redirect.
// Page bodies and chrome are unchanged; only the address changes.
//
// Kept separate from the React components in App.tsx (which just read hooks
// — useConfig, useSessionGet, useGoalDetail — and feed the results in here)
// so the "which URL does this land on" decisions are unit-testable without a
// DOM. Same split as `resolveSettingsRoute` in
// `pages/settings/lib/resolve-settings-route.ts`.
//
// T1 of plan/phases/teams-as-a-scope.md: every builder that emits a `/p/`
// path takes an optional trailing `teamId` and emits the team-prefixed
// workspace `/t/:teamId/p/:personalityId/…` when given (D6 — a member's
// workspace is the same workspace, under the team's prefix). Omitted → the
// independent form, exactly as before.

/**
 * `/p/:personalityId`, or `/t/:teamId/p/:personalityId` when a team is in
 * scope — the one place the two workspace prefixes are spelled.
 */
function workspacePrefix(personalityId: string, teamId?: string | null): string {
  return teamId ? `/t/${teamId}/p/${personalityId}` : `/p/${personalityId}`;
}

/**
 * The fallback chain when nothing more specific (a session's or a goal's own
 * personality) is available: last-visited agent, else the operator's config
 * default, else the same hardcoded fallback `useActivePersonality.ts` already
 * uses.
 */
export function resolveFallbackPersonalityId(
  lastVisitedId: string | null,
  configPersonalityId: string | undefined,
): string {
  return lastVisitedId ?? configPersonalityId ?? 'researcher';
}

/**
 * `/` and `/chat` (with or without `?session=`) resolve in this order: the
 * URL's `?session=`'s personality, else the fallback chain above. Returns
 * `null` while a session lookup is still in flight — the caller renders
 * nothing rather than guessing and redirecting twice.
 */
export function resolveChatRedirectPath(input: {
  sessionId: string | null;
  sessionLoading: boolean;
  sessionPersonalityId: string | null | undefined;
  fallbackPersonalityId: string;
  search: string;
  teamId?: string | null;
}): string | null {
  const { sessionId, sessionLoading, sessionPersonalityId, fallbackPersonalityId, search } = input;
  if (sessionId && sessionLoading) return null;
  const personalityId = (sessionId ? sessionPersonalityId : null) ?? fallbackPersonalityId;
  return `${workspacePrefix(personalityId, input.teamId)}/chat${search}`;
}

/**
 * The old flat workspace routes with no personality context of their own —
 * `/sessions`, `/memory`, `/documents`, `/cron` (→ `schedule`), `/goals`,
 * `/tasks`. Always the fallback chain; there is nothing in these URLs to
 * resolve a personality from.
 */
export function buildWorkspaceRedirectPath(
  fallbackPersonalityId: string,
  suffix: string,
  search: string,
  teamId?: string | null,
): string {
  return `${workspacePrefix(fallbackPersonalityId, teamId)}/${suffix}${search}`;
}

/**
 * `/goals/:id` → `/p/:personalityId/goals/:goalId` — the goal's own
 * personality once it loads; the fallback chain if the goal has none or
 * failed to load. Returns `null` while the lookup is in flight.
 */
export function resolveGoalRedirectPath(input: {
  goalId: string;
  goalLoading: boolean;
  goalPersonalityId: string | null | undefined;
  fallbackPersonalityId: string;
  search: string;
  teamId?: string | null;
}): string | null {
  const { goalId, goalLoading, goalPersonalityId, fallbackPersonalityId, search } = input;
  if (goalLoading) return null;
  const personalityId = goalPersonalityId ?? fallbackPersonalityId;
  return `${workspacePrefix(personalityId, input.teamId)}/goals/${goalId}${search}`;
}

/** `/personalities/:id` → `/p/:id/identity` — the id IS the personality id
 * already; no lookup needed. */
export function buildIdentityRedirectPath(
  id: string,
  search: string,
  teamId?: string | null,
): string {
  return `${workspacePrefix(id, teamId)}/identity${search}`;
}

/** `/p/:personalityId/chat` for a personality already known outright (e.g.
 * onboarding just picked one) — no redirect indirection needed. */
export function buildWorkspaceChatPath(personalityId: string, teamId?: string | null): string {
  return `${workspacePrefix(personalityId, teamId)}/chat`;
}

/** `/t/:teamId/<pane>` — a team-altitude destination (plan §1). Defaults to
 * `overview`, the team's home (D5). */
export function buildTeamPath(teamId: string, pane = 'overview'): string {
  return `/t/${teamId}/${pane}`;
}

/**
 * The pane segment right after `/p/:personalityId/` (or
 * `/t/:teamId/p/:personalityId/`) — "memory", "chat", "goals" (a nested goal
 * id is dropped; a goal belongs to the personality that started it, so
 * switching agents can't carry it over). Falls back to "chat" for a bare
 * `/p/:id` with no trailing segment.
 */
export function currentWorkspacePane(pathname: string): string {
  const match = pathname.match(/^(?:\/t\/[^/]+)?\/p\/[^/]+\/([^/]+)/);
  return match?.[1] ?? 'chat';
}

/**
 * Where `AltitudeRail` should send you when you click a different
 * personality mark: the SAME pane under the new personality (P2's "Done
 * when": switching agents keeps you on the current pane) — except Chat,
 * which the caller handles separately (it needs the target's own last
 * session, not carried over from whoever you were just talking to). This
 * function never copies a query string, so a plain `/p/:id/chat` result
 * naturally drops any `?session=` left over from the previous agent.
 * Inside a team the rail passes `teamId` so a member switch stays in the
 * team's scope.
 */
export function buildRailSwitchPath(
  pathname: string,
  targetPersonalityId: string,
  teamId?: string | null,
): string {
  return `${workspacePrefix(targetPersonalityId, teamId)}/${currentWorkspacePane(pathname)}`;
}

/**
 * Matches the pre-P1a bare `/chat`, the `/p/:personalityId/chat` workspace
 * chat, and its team-prefixed twin `/t/:teamId/p/:personalityId/chat`. Used
 * wherever chrome used to gate on `pathname === '/chat'` (the activity
 * drawer in App.tsx / StatusBar.tsx) so that gate keeps working once Chat
 * moves. The team's own Chat pane (`/t/:teamId/chat`) is deliberately not
 * matched here — it lands in T3 with its own surface.
 */
export function isChatPathname(pathname: string): boolean {
  return pathname === '/chat' || /^(?:\/t\/[^/]+)?\/p\/[^/]+\/chat$/.test(pathname);
}

/**
 * A session-open action's target: the session's own personality when known
 * (skips the redirect hop), else the old unscoped `/chat?session=` deep link
 * — still a permanent redirect, so it still lands correctly. `teamId` only
 * applies when the personality is known; the unscoped deep link has no
 * personality to put under a team.
 */
export function sessionOpenPath(
  sessionId: string,
  sessionPersonalityId: string | null,
  teamId?: string | null,
): string {
  return sessionPersonalityId
    ? `${workspacePrefix(sessionPersonalityId, teamId)}/chat?session=${sessionId}`
    : `/chat?session=${sessionId}`;
}
