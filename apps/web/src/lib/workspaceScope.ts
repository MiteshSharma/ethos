// Pure client-side filters for P2 (plan/phases/personality-first-ui.md) — "scope
// the existing pages". Six workspace panes pass `personalityId` straight into a
// shipping RPC (Sessions, Memory, Documents, Skills, MCP, Plugins); the other
// three — Schedule, Goals, Tasks — get it client-side because the row schema
// already carries `personalityId` and the RPC input doesn't take one. Kept here,
// separate from the page components, so the filtering decisions are
// unit-testable without a DOM — same split as `scopeNav.ts` and
// `workspaceRoutes.ts`.
//
// `filterTasksForLibrary` was added in P3 for the "All tasks" Library twin —
// the counterpart to `filterTasksForWorkspace`, same relationship
// `filterCronJobsForLibrary` already has to `filterCronJobsForWorkspace`.

/** Minimal shape `filterCronJobsForWorkspace` / `...ForLibrary` need — a
 *  structural subset of `CronJob` from `@ethosagent/web-contracts`. */
interface CronJobLike {
  source?: 'user' | 'system' | null;
  personalityId: string;
}

/** Workspace Schedule pane: this agent's own jobs only. System jobs (digest,
 *  watchers) never belong here even if `source` is missing on the wire —
 *  the CronJob schema defaults it to `'user'`, so an absent `source` is
 *  treated the same way. */
export function filterCronJobsForWorkspace<T extends CronJobLike>(
  jobs: readonly T[],
  personalityId: string,
): T[] {
  return jobs.filter((j) => (j.source ?? 'user') === 'user' && j.personalityId === personalityId);
}

/** Library Advanced's "System cron" destination: machine-wide jobs, not
 *  trapped under whoever was stamped on create. */
export function filterCronJobsForLibrary<T extends CronJobLike>(jobs: readonly T[]): T[] {
  return jobs.filter((j) => j.source === 'system');
}

/** Minimal shape for goals filtering — `GoalSchema.personalityId` is
 *  required (non-nullable), unlike sessions/tasks. */
interface GoalLike {
  personalityId: string;
}

/** Workspace Goals pane: this agent's own goals only. `goals.list` has no
 *  `personalityId` input, so this filter is the only scoping mechanism —
 *  intentional per the plan's "no backend changes" constraint. */
export function filterGoalsByPersonality<T extends GoalLike>(
  goals: readonly T[],
  personalityId: string,
): T[] {
  return goals.filter((g) => g.personalityId === personalityId);
}

/** Minimal shape for tasks filtering — `BackgroundJobSummarySchema.personalityId`
 *  is nullable (a job spawned outside any personality context). */
interface TaskLike {
  personalityId: string | null;
}

/** Workspace Tasks pane: this agent's own jobs only. A `null` personalityId
 *  (unscoped background jobs) is hidden here — those surface at the Library
 *  altitude instead (P3's "All tasks" twin — `filterTasksForLibrary` below). */
export function filterTasksForWorkspace<T extends TaskLike>(
  jobs: readonly T[],
  personalityId: string,
): T[] {
  return jobs.filter((j) => j.personalityId === personalityId);
}

/** Library "All tasks" twin (P3): unscoped background jobs — spawned outside
 *  any personality context. The workspace Tasks pane hides these
 *  (`filterTasksForWorkspace` above); this is where they surface instead. */
export function filterTasksForLibrary<T extends TaskLike>(jobs: readonly T[]): T[] {
  return jobs.filter((j) => j.personalityId === null);
}

/** Minimal shape for session-list personality filtering — shared by
 *  `scopeNav.ts`'s session block (Part B) and the Tasks pane's session
 *  picker, which both need "just this agent's sessions". */
interface SessionLike {
  personalityId: string | null;
}

/** Sessions belonging to one personality, in the order they were given (the
 *  caller is expected to hand in an already-recency-sorted list — this
 *  function only filters). */
export function filterSessionsByPersonality<T extends SessionLike>(
  sessions: readonly T[],
  personalityId: string,
): T[] {
  return sessions.filter((s) => s.personalityId === personalityId);
}

/** Minimal shape for "which session should Chat restore" — id + the two
 *  fields needed to pick the most recent match. */
interface RecentSessionLike {
  id: string;
  personalityId: string | null;
  updatedAt: string;
}

/**
 * The Chat session-restore-on-switch decision (plan's "Done when": switching
 * agents on Chat restores that agent's last session, or lands on an empty
 * chat — never a foreign `?session=`). Picks the most-recently-updated
 * session that belongs to `personalityId`, or `null` when it has none.
 *
 * Deliberately re-sorts rather than trusting input order: `useRecentSessions`
 * already returns recency-sorted data, but a pure function shouldn't assume
 * that of its caller.
 */
export function mostRecentSessionIdForPersonality<T extends RecentSessionLike>(
  sessions: readonly T[],
  personalityId: string,
): string | null {
  const matches = filterSessionsByPersonality(sessions, personalityId);
  if (matches.length === 0) return null;
  const sorted = [...matches].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return sorted[0]?.id ?? null;
}
