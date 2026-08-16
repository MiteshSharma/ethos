import { Dropdown, type MenuProps, Tooltip } from 'antd';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { usePersonalityList } from '../features/personalities/api/queries';
import { extractWorkspacePersonalityId } from '../lib/scopeNav';
import { buildRailSwitchPath } from '../lib/workspaceRoutes';
import { EthosMark } from './ui/EthosMark';
import { PersonalityRingAvatar } from './ui/PersonalityRingAvatar';

// P1b — plan/phases/personality-first-ui.md. The 56px altitude rail: global
// chrome, stays neutral forever per the DESIGN.md amendment — the rail is
// outside the personality subtree even though the contextual column next to
// it isn't. "Neutral" is `--ethos-text` for the Ethos ring specifically
// (see styles.css `.altitude-rail-ethos-btn`) and `--ethos-info` for the
// active-mark selection ring — never the active scope's `--accent`.
//
//   Ethos ring → divider → one PersonalityRingAvatar per agent → "+" new agent.
//
// No presence dots — there is no "who is busy" RPC (deferred, see plan's
// non-goals). Clicking a mark keeps you on the CURRENT pane under the new
// personality (P2's "Done when") — `/p/engineer/memory` → `/p/researcher/memory`
// — via `buildRailSwitchPath`. Chat is the one exception in spirit, not in
// this component: the path it lands on (`/p/:id/chat`, no query string) is
// exactly what a plain pane-preserving switch already produces, since this
// function never copies `?session=`. Chat.tsx itself is what restores the
// target agent's own last session (or renders empty) once it mounts there.

// The rail `+`'s dropdown menu — "Quick create" opens the fast-path
// `NewAgentDialog` (P5), "Create with architect" is today's chat flow.
// Both stay reachable; quick create is not a substitute for the architect.
const NEW_AGENT_MENU_ITEMS: MenuProps['items'] = [
  { key: 'quick-create', label: 'Quick create' },
  { key: 'architect', label: 'Create with architect' },
];

export function AltitudeRail({ onOpenQuickCreate }: { onOpenQuickCreate: () => void }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const activePersonalityId = extractWorkspacePersonalityId(pathname);
  const { data } = usePersonalityList();
  const items = data?.items ?? [];

  return (
    <nav className="altitude-rail" aria-label="Altitude">
      {/* The Library landing page: `/personalities` (the Roster) is the one
          bare destination that isn't itself a workspace redirect — unlike
          `/sessions`, `/goals`, etc., which bounce straight back into a
          personality workspace via the P1a fallback chain. Landing there
          keeps the ring's click inside the Library altitude it names. */}
      <Tooltip title="Library" placement="right">
        <Link to="/personalities" className="altitude-rail-ethos-btn" aria-label="Library">
          <EthosMark size={24} />
        </Link>
      </Tooltip>

      <div className="altitude-rail-divider" aria-hidden="true" />

      <div className="altitude-rail-marks">
        {items.map((p) => (
          <Tooltip key={p.id} title={p.name} placement="right">
            <Link
              to={buildRailSwitchPath(pathname, p.id)}
              className={`altitude-rail-mark-btn${p.id === activePersonalityId ? ' active' : ''}`}
              aria-label={p.name}
              aria-current={p.id === activePersonalityId ? 'page' : undefined}
            >
              <PersonalityRingAvatar personalityId={p.id} size={32} />
            </Link>
          </Tooltip>
        ))}
      </div>

      <Tooltip title="New agent" placement="right">
        <Dropdown
          menu={{
            items: NEW_AGENT_MENU_ITEMS,
            onClick: ({ key }) => {
              if (key === 'quick-create') onOpenQuickCreate();
              else if (key === 'architect') navigate('/personality/create');
            },
          }}
          trigger={['click']}
          placement="topLeft"
        >
          <button type="button" className="altitude-rail-new-btn" aria-label="New agent">
            +
          </button>
        </Dropdown>
      </Tooltip>
    </nav>
  );
}
