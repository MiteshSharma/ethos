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
}): string | null {
  const { sessionId, sessionLoading, sessionPersonalityId, fallbackPersonalityId, search } = input;
  if (sessionId && sessionLoading) return null;
  const personalityId = (sessionId ? sessionPersonalityId : null) ?? fallbackPersonalityId;
  return `/p/${personalityId}/chat${search}`;
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
): string {
  return `/p/${fallbackPersonalityId}/${suffix}${search}`;
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
}): string | null {
  const { goalId, goalLoading, goalPersonalityId, fallbackPersonalityId, search } = input;
  if (goalLoading) return null;
  const personalityId = goalPersonalityId ?? fallbackPersonalityId;
  return `/p/${personalityId}/goals/${goalId}${search}`;
}

/** `/personalities/:id` → `/p/:id/identity` — the id IS the personality id
 * already; no lookup needed. */
export function buildIdentityRedirectPath(id: string, search: string): string {
  return `/p/${id}/identity${search}`;
}

/** `/p/:personalityId/chat` for a personality already known outright (e.g.
 * onboarding just picked one) — no redirect indirection needed. */
export function buildWorkspaceChatPath(personalityId: string): string {
  return `/p/${personalityId}/chat`;
}

/**
 * The pane segment right after `/p/:personalityId/` — "memory", "chat",
 * "goals" (a nested goal id is dropped; a goal belongs to the personality
 * that started it, so switching agents can't carry it over). Falls back to
 * "chat" for a bare `/p/:id` with no trailing segment.
 */
export function currentWorkspacePane(pathname: string): string {
  const match = pathname.match(/^\/p\/[^/]+\/([^/]+)/);
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
 */
export function buildRailSwitchPath(pathname: string, targetPersonalityId: string): string {
  return `/p/${targetPersonalityId}/${currentWorkspacePane(pathname)}`;
}

/**
 * Matches both the pre-P1a bare `/chat` and the new `/p/:personalityId/chat`.
 * Used wherever chrome used to gate on `pathname === '/chat'` (the activity
 * drawer in App.tsx / StatusBar.tsx) so that gate keeps working once Chat
 * moves.
 */
export function isChatPathname(pathname: string): boolean {
  return pathname === '/chat' || /^\/p\/[^/]+\/chat$/.test(pathname);
}

/**
 * A session-open action's target: the session's own personality when known
 * (skips the redirect hop), else the old unscoped `/chat?session=` deep link
 * — still a permanent redirect, so it still lands correctly.
 */
export function sessionOpenPath(sessionId: string, sessionPersonalityId: string | null): string {
  return sessionPersonalityId
    ? `/p/${sessionPersonalityId}/chat?session=${sessionId}`
    : `/chat?session=${sessionId}`;
}
