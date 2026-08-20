import { isLightSurface } from '@ethosagent/design-tokens/antd';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useConfig } from '../features/config/api/queries';
import { getLastPersonalityId } from '../lib/lastPersonality';
import { getLastSessionId } from '../lib/lastSession';
import { allRuns, type RunsState, runCounts } from '../lib/pi-run-reducer';
import { resolveRunner, runnerAccentVars } from '../lib/runners';
import { useResolvedTokens } from '../lib/skin-tokens';
import { RUN_COPY } from '../lib/worker-copy';
import { isChatPathname, resolveFallbackPersonalityId } from '../lib/workspaceRoutes';
import { subscribeToSession } from '../sse';

interface StatusBarProps {
  drawerOpen: boolean;
  onToggleDrawer: () => void;
  /** Delegated runs on the active session — the §4.4 pill. */
  runs?: RunsState;
}

/** Track pending skill proposals via SSE events. */
function useSkillProposalCount(): number {
  const [count, setCount] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(() => getLastSessionId());

  useEffect(() => {
    const refresh = () => setSessionId(getLastSessionId());
    window.addEventListener('storage', refresh);
    window.addEventListener('ethos:active-session-changed', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('ethos:active-session-changed', refresh);
    };
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    const sub = subscribeToSession(sessionId, {
      onEvent: (event) => {
        if (event.type === 'evolve.skill_pending') {
          setCount((c) => c + 1);
        } else if (event.type === 'evolve.skill_applied') {
          setCount((c) => Math.max(0, c - 1));
        }
      },
    });
    return () => sub.close();
  }, [sessionId]);

  return count;
}

/**
 * §4.4 — the run pill. Machine-wide, on the status bar, and hidden when no run
 * exists. Persistent state, never a toast: a notice that vanishes while you are
 * in another tab is the same as no notice at all.
 */
function RunPill({ runs }: { runs: RunsState }) {
  const tokens = useResolvedTokens();
  const light = isLightSurface(tokens);
  const rows = allRuns(runs);
  const first = rows[0];
  if (!first) return null;
  const runner = resolveRunner(first.runner);
  const counts = runCounts(runs);
  const text = RUN_COPY.statusPill(runner, counts);
  if (!text) return null;
  return (
    <>
      <span className="sb-sep" />
      <span
        className={`sb-run-pill${counts.needsYou > 0 ? ' sb-run-pill--needs-you' : ''}`}
        style={runnerAccentVars(runner, light)}
      >
        {text}
      </span>
    </>
  );
}

export function StatusBar({ drawerOpen, onToggleDrawer, runs }: StatusBarProps) {
  const { data, error, isLoading } = useConfig();
  const { pathname } = useLocation();
  const isChat = isChatPathname(pathname);
  const skillProposalCount = useSkillProposalCount();
  // Cron moved under the workspace (P1a) — same fallback chain `/cron`'s
  // redirect uses: last-visited agent, else the config default.
  const cronPersonalityId = resolveFallbackPersonalityId(getLastPersonalityId(), data?.personality);

  const statusState: 'connected' | 'connecting' | 'offline' = isLoading
    ? 'connecting'
    : error
      ? 'offline'
      : 'connected';

  const statusLabel = isLoading ? 'connecting…' : error ? 'offline' : 'Backend connected';

  const providerModel = data ? `${data.provider} · ${data.model}` : '—';

  return (
    <footer className="statusbar">
      <span className={`sb-dot sb-dot--${statusState}`} aria-hidden="true" />
      <span>{statusLabel}</span>

      <span className="sb-sep" />
      <Link to="/activity" className="sb-link">
        Activity
      </Link>
      <span className="sb-sep" />
      <Link to={`/p/${cronPersonalityId}/schedule`} className="sb-link">
        Cron
      </Link>
      {skillProposalCount > 0 && (
        <>
          <span className="sb-sep" />
          <Link to="/skills" className="sb-link">
            Skills{' '}
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: 16,
                height: 16,
                borderRadius: 'var(--radius-md)',
                backgroundColor: 'var(--ethos-accent, #1677ff)',
                color: '#fff',
                fontSize: 10,
                fontWeight: 600,
                padding: '0 4px',
                marginLeft: 2,
              }}
            >
              {skillProposalCount}
            </span>
          </Link>
        </>
      )}

      {runs ? <RunPill runs={runs} /> : null}

      <span className="sb-spacer" />
      {isChat && (
        <button
          type="button"
          className="sb-link"
          onClick={onToggleDrawer}
          aria-label={drawerOpen ? 'Close drawer' : 'Open drawer'}
          style={{
            width: 28,
            height: 28,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          <svg
            aria-hidden="true"
            width={16}
            height={16}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
          >
            <rect x="1" y="2" width="14" height="12" rx="2" />
            <line x1="10" y1="2" x2="10" y2="14" />
          </svg>
        </button>
      )}
      <span>{providerModel}</span>
    </footer>
  );
}
