import { App as AntApp } from 'antd';
import { type ReactNode, useEffect } from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { useTeamsList } from '../features/teams/api/queries';
import { buildTeamPath } from '../lib/workspaceRoutes';

// Route-level guards and redirects for the team altitude
// (plan/phases/teams-as-a-scope.md §1 "Precedence when a URL is ambiguous",
// D6). Each one renders instead of, or around, a page body — the same
// `<Navigate replace>` pattern as App.tsx's P1a redirects — and lives here
// rather than in App.tsx so the redirect table is testable with a
// `MemoryRouter` and a mocked `rpc.teams.list`.

/** `/t/:teamId` → `/t/:teamId/overview` — the team's home (D5). */
export function TeamHomeRedirect() {
  const { teamId = '' } = useParams<{ teamId: string }>();
  return <Navigate to={buildTeamPath(teamId)} replace />;
}

/** The pre-T1 Control Center address, `/teams/:name` → `/t/:name/board`. */
export function LegacyTeamRedirect() {
  const { name = '' } = useParams<{ name: string }>();
  const { search } = useLocation();
  return <Navigate to={`${buildTeamPath(name, 'board')}${search}`} replace />;
}

/**
 * Wraps every `/p/:personalityId/*` route: a personality that belongs to a
 * team is redirected to the same pane under the team's prefix,
 * `/t/<firstTeam>/p/:personalityId/*` (first team in `teams.list` order when
 * it is in several, D6). Independent personalities pass straight through, as
 * does everything when `teams.list` fails — a down teams service must not
 * take the workspaces down with it. Renders nothing until the list has
 * answered once, so a member's page never mounts and then bounces.
 */
export function TeamMemberRedirect({ children }: { children: ReactNode }) {
  const { personalityId = '' } = useParams<{ personalityId: string }>();
  const { pathname, search } = useLocation();
  const { data, isError } = useTeamsList();
  if (!data) return isError ? children : null;
  const team = data.items.find((t) => t.members.some((m) => m.personalityId === personalityId));
  if (!team) return children;
  return <Navigate to={`/t/${team.name}${pathname}${search}`} replace />;
}

type Verdict = 'pending' | 'ok' | 'unknown-team' | 'not-member';

/**
 * Wraps every `/t/:teamId/*` route. An unknown team goes to `/teams`; a
 * `/t/:teamId/p/:personalityId/*` whose personality is not a member goes to
 * the team's overview. Both say why in a toast. Pending → nothing; the
 * list failing → pass through (nothing to validate against).
 */
export function TeamScopeGuard({ children }: { children: ReactNode }) {
  const { teamId = '', personalityId } = useParams<{ teamId: string; personalityId?: string }>();
  const { data, isError } = useTeamsList();
  const { message } = AntApp.useApp();

  let verdict: Verdict = 'pending';
  if (data) {
    const team = data.items.find((t) => t.name === teamId);
    if (!team) verdict = 'unknown-team';
    else if (personalityId && !team.members.some((m) => m.personalityId === personalityId))
      verdict = 'not-member';
    else verdict = 'ok';
  }

  useEffect(() => {
    if (verdict === 'unknown-team') void message.warning(`No team named "${teamId}"`);
    else if (verdict === 'not-member') void message.warning(`${personalityId} is not in ${teamId}`);
  }, [verdict, teamId, personalityId, message]);

  if (isError || verdict === 'ok') return children;
  if (verdict === 'pending') return null;
  if (verdict === 'unknown-team') return <Navigate to="/teams" replace />;
  return <Navigate to={buildTeamPath(teamId)} replace />;
}
