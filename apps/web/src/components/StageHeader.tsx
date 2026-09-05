import { Dropdown, type MenuProps } from 'antd';
import { type ReactNode, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { usePersonalityList } from '../features/personalities/api/queries';
import { filterSelectablePersonalities } from '../features/personalities/constants';
import { useTeamMembership } from '../features/teams/api/queries';
import { teamAccents } from '../features/teams/lib/membership';
import { createActionForPathname, createActionHref } from '../lib/createActions';
import {
  capitalize,
  extractTeamId,
  extractWorkspacePersonalityId,
  resolveBreadcrumb,
} from '../lib/scopeNav';
import { switcherRows } from '../lib/scopeSwitcher';
import { buildTeamPath, buildWorkspaceChatPath } from '../lib/workspaceRoutes';
import { TeamRing } from './ui/TeamRing';

// P1b — plan/phases/personality-first-ui.md. The breadcrumb that lives "in
// every stage header" — chrome, not page body: rendered by App.tsx in its
// own grid row above the routed content, so no page component changes to
// get it.
//
// teams-as-a-scope T1 (D2/§2): the ROOT crumb is the scope switcher — one
// button at every altitude that opens Independent · every team · New team,
// so the way out of a team is the way in. It reads `Independent ▾` at the
// Library and in an independent workspace (the agent becomes the middle
// crumb), and `<ring> <team> ▾` inside a team. The switcher is neutral
// chrome; the agent crumb keeps the workspace `--accent` (App.tsx's
// wrapper) via `.stage-header-scope`.
//
// P5 — "Per-list create actions": the trailing button, when the current
// route has one (`../lib/createActions.ts`). StageHeader never renders a
// modal itself; clicking just navigates to the pane's own create trigger.

export interface StageHeaderProps {
  /** T4's "Needs you" pill (D11) — rendered in the right slot, before the
   *  create action. Nothing passes it yet. */
  needsYouSlot?: ReactNode;
}

export function StageHeader({ needsYouSlot }: StageHeaderProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const personalityId = extractWorkspacePersonalityId(pathname);
  const teamId = extractTeamId(pathname);
  const { data } = usePersonalityList();
  const membership = useTeamMembership();
  const team = teamId ? (membership.teams.find((t) => t.name === teamId) ?? null) : null;
  const name = personalityId
    ? (data?.items.find((p) => p.id === personalityId)?.name ?? capitalize(personalityId))
    : null;

  const crumb = resolveBreadcrumb(pathname, name, team?.name);
  if (!crumb) return null;

  const createAction = createActionForPathname(pathname);
  const createHref = createAction ? createActionHref(createAction, personalityId) : null;

  const selectableIds = filterSelectablePersonalities(data?.items ?? []).map((p) => p.id);
  const independentCount = membership.independentIds(selectableIds).length;

  // The agent crumb: `personalityLabel` inside a team; at an independent
  // workspace the lib puts the agent in `scopeLabel` (the root there) and
  // the switcher takes the root instead, so the agent moves one crumb in.
  const agentLabel = teamId
    ? crumb.personalityLabel
    : crumb.altitude === 'workspace'
      ? crumb.scopeLabel
      : undefined;
  const agentHref = personalityId ? buildWorkspaceChatPath(personalityId, teamId) : null;

  return (
    <header className="stage-header">
      <ScopeSwitcher
        activeTeamId={teamId}
        label={teamId ? crumb.scopeLabel : 'Independent'}
        glyph={
          team ? (
            <TeamRing accents={teamAccents(team)} size={14} title={team.name} />
          ) : teamId ? (
            <TeamRing accents={[]} size={14} title={teamId} />
          ) : (
            <Annulus size={14} />
          )
        }
        teams={membership.teams}
        independentCount={independentCount}
      />
      {agentLabel && agentHref ? (
        <>
          <span className="stage-header-sep" aria-hidden="true">
            /
          </span>
          <Link to={agentHref} className="stage-header-scope">
            {agentLabel}
          </Link>
        </>
      ) : null}
      <span className="stage-header-sep" aria-hidden="true">
        /
      </span>
      <span className="stage-header-pane">{crumb.paneLabel}</span>
      <span style={{ flex: 1 }} />
      {needsYouSlot}
      {createAction && createHref && (
        <button type="button" className="page-action-btn" onClick={() => navigate(createHref)}>
          {createAction.label}
        </button>
      )}
    </header>
  );
}

/** The Ethos annulus as a CSS ring — the machine altitude's mark at the
 *  small sizes the breadcrumb and the switcher use (prototype `.annulus`). */
function Annulus({ size }: { size: number }) {
  const borderWidth = Math.max(3, size * 0.18);
  return (
    <span
      className="scope-annulus"
      aria-hidden="true"
      style={{ width: size, height: size, borderWidth }}
    />
  );
}

interface ScopeSwitcherProps {
  activeTeamId: string | null;
  label: string;
  glyph: ReactNode;
  teams: ReturnType<typeof useTeamMembership>['teams'];
  independentCount: number;
}

function ScopeSwitcher({
  activeTeamId,
  label,
  glyph,
  teams,
  independentCount,
}: ScopeSwitcherProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const items = useMemo<MenuProps['items']>(() => {
    const rows = switcherRows(teams, independentCount);
    const independent = rows.flatMap((r) => (r.kind === 'independent' ? [r] : []));
    const teamRows = rows.flatMap((r) => (r.kind === 'team' ? [r] : []));
    const out: MenuProps['items'] = [
      {
        type: 'group',
        label: 'SCOPE',
        children: independent.map((r) => ({
          key: 'independent',
          className: activeTeamId === null ? 'scope-switcher-active' : undefined,
          label: (
            <SwitcherRow
              glyph={<Annulus size={16} />}
              name="Independent"
              sub="personalities in no team"
              count={r.count}
            />
          ),
        })),
      },
    ];
    if (teamRows.length > 0) {
      out.push({ type: 'divider' });
      out.push({
        type: 'group',
        label: 'TEAMS',
        children: teamRows.map((r) => ({
          key: `team:${r.team.name}`,
          className: activeTeamId === r.team.name ? 'scope-switcher-active' : undefined,
          label: (
            <SwitcherRow
              glyph={<TeamRing accents={teamAccents(r.team)} size={18} title={r.team.name} />}
              name={r.team.name}
              sub={r.status}
              count={r.team.members.length}
            />
          ),
        })),
      });
    }
    out.push({ type: 'divider' });
    out.push({
      key: 'new',
      className: 'scope-switcher-new',
      label: <SwitcherRow glyph={<span className="scope-switcher-plus">+</span>} name="New team" />,
    });
    return out;
  }, [teams, independentCount, activeTeamId]);

  const onClick: MenuProps['onClick'] = ({ key }) => {
    setOpen(false);
    if (key === 'independent') navigate('/personalities');
    else if (key === 'new') navigate('/teams/create');
    else if (key.startsWith('team:')) navigate(buildTeamPath(key.slice('team:'.length)));
  };

  return (
    <Dropdown
      menu={{ items, onClick, selectable: false }}
      trigger={['click']}
      open={open}
      onOpenChange={setOpen}
      placement="bottomLeft"
      classNames={{ root: 'scope-switcher' }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Esc-to-close for the popup the button owns */}
      <span
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        <button
          type="button"
          className="stage-header-scope-btn"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Scope: ${label}`}
        >
          {glyph}
          <span className="stage-header-scope-label">{label}</span>
          <span className="stage-header-scope-caret" aria-hidden="true">
            ▾
          </span>
        </button>
      </span>
    </Dropdown>
  );
}

function SwitcherRow({
  glyph,
  name,
  sub,
  count,
}: {
  glyph: ReactNode;
  name: string;
  sub?: string;
  count?: number;
}) {
  return (
    <span className="scope-switcher-row">
      {glyph}
      <span className="scope-switcher-text">
        {name}
        {sub ? <span className="scope-switcher-sub">{sub}</span> : null}
      </span>
      {count !== undefined ? <span className="scope-switcher-count">{count}</span> : null}
    </span>
  );
}
