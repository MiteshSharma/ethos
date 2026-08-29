import { isLightSurface } from '@ethosagent/design-tokens/antd';
import { useNavigate } from 'react-router-dom';
import {
  type DrawerNotification,
  type ToolStreamEntry,
  type UsageState,
  useDrawerStream,
} from '../hooks/useDrawerStream';
import { type ClarifyQueueState, questionForRun } from '../lib/clarify-queue';
import { allRuns, type RunState, type RunsState, runsNeedingYou } from '../lib/pi-run-reducer';
import { resolveRunner, runnerAccentVars } from '../lib/runners';
import { useResolvedTokens } from '../lib/skin-tokens';
import { RUN_COPY } from '../lib/worker-copy';
import { DebugPanel } from './DebugPanel';

// Right-side observability drawer. Three panes, top-to-bottom:
//
//   1. Tool stream     — live tool_start/end events for the active session
//   2. Notifications   — push events (cron firings, mesh changes, evolved
//                        skills awaiting review). Click deep-links to the
//                        relevant tab.
//   3. Usage           — last-seen token + cost counter for the session
//
// Visibility is owned by App.tsx so the same toggle button (in TopBar) can
// flip it across tabs. Per the plan: default visible at ≥1280px, toggleable
// below. The drawer renders even when there's no active session — empty
// states are practical, not cheerful.

export interface RightDrawerProps {
  open: boolean;
  onClose: () => void;
  debugPanelEnabled?: boolean;
  /** Delegated runs on the active session — the top pane (§4.3). */
  runs?: RunsState;
  /** Questions those runs are parked on, quoted on the row (§4.3). */
  clarifyQueue?: ClarifyQueueState;
}

export function RightDrawer({
  open,
  onClose,
  debugPanelEnabled,
  runs,
  clarifyQueue,
}: RightDrawerProps) {
  const { sessionId, toolStream, notifications, usage } = useDrawerStream();

  if (!open) return null;

  return (
    <aside className="right-drawer" aria-label="Activity drawer">
      <div className="right-drawer-header">
        <span className="right-drawer-title">Activity</span>
        <button
          type="button"
          className="right-drawer-close"
          aria-label="Close drawer"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <div className="right-drawer-scroll">
        {runs ? <RunsPane runs={runs} clarifyQueue={clarifyQueue} /> : null}

        <Section title="Tool stream">
          {!sessionId ? (
            <EmptyHint>No active session. Start a chat to see tool calls live.</EmptyHint>
          ) : toolStream.length === 0 ? (
            <EmptyHint>Quiet for now. Tool activity appears here as the agent works.</EmptyHint>
          ) : (
            <ul className="right-drawer-list">
              {toolStream.map((e) => (
                <ToolStreamRow key={e.toolCallId} entry={e} />
              ))}
            </ul>
          )}
        </Section>

        <Section title="Notifications">
          {notifications.length === 0 ? (
            <EmptyHint>No notifications. Cron firings and pending skills surface here.</EmptyHint>
          ) : (
            <ul className="right-drawer-list">
              {notifications.map((n) => (
                <NotificationRow key={n.id} notification={n} />
              ))}
            </ul>
          )}
        </Section>

        <Section title="Usage">
          {!usage ? (
            <EmptyHint>No usage yet for this session.</EmptyHint>
          ) : (
            <UsageBlock usage={usage} />
          )}
        </Section>
      </div>

      {debugPanelEnabled && <DebugPanel sessionId={sessionId} />}
    </aside>
  );
}

/**
 * §4.3 — the top pane of the drawer, above Tool stream. Deliberately NOT a new
 * sidebar: a permanent column for something idle most of the day is the "cards
 * earn existence" failure, and a second live-events column would compete with
 * the drawer that already streams tool calls.
 *
 * Rows are dense rows, and stay dense rows — the run CARD is the singleton
 * inline in the transcript; this is the list.
 */
function RunsPane({ runs, clarifyQueue }: { runs: RunsState; clarifyQueue?: ClarifyQueueState }) {
  const rows = allRuns(runs);
  const needsYou = runsNeedingYou(runs).length;
  const tokens = useResolvedTokens();
  const light = isLightSurface(tokens);
  return (
    <section className="right-drawer-section">
      <h3 className="right-drawer-section-title">
        <span>Runs {rows.length > 0 ? rows.length : ''}</span>
        {needsYou > 0 ? (
          <span className="runs-pane-needs-you">{RUN_COPY.needsYouSummary(needsYou)}</span>
        ) : null}
      </h3>
      {rows.length === 0 ? (
        <EmptyHint>{RUN_COPY.drawerEmpty}</EmptyHint>
      ) : (
        <ul className="right-drawer-list">
          {rows.map((run) => (
            <RunRow
              key={run.jobId}
              run={run}
              light={light}
              {...(clarifyQueue
                ? { question: questionForRun(clarifyQueue, run.jobId)?.question }
                : {})}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function RunRow({ run, light, question }: { run: RunState; light: boolean; question?: string }) {
  const runner = resolveRunner(run.runner);
  const blocked = run.status === 'blocked';
  // A blocked row quotes the question instead of the `now` line: what the run
  // is doing is "waiting for you", and the useful half is what it asked.
  const second = blocked && question ? `\u201c${truncate(question, 90)}\u201d` : run.now;
  return (
    <li
      className={`runs-pane-row${blocked ? ' runs-pane-row--blocked' : ''}`}
      style={runnerAccentVars(runner, light)}
    >
      <div className="runs-pane-row-head">
        <span className="runs-pane-badge talk-mono">{runner.badgeText}</span>
        <span className="runs-pane-label talk-mono">{shortLabel(run.jobId)}</span>
        <span className="runs-pane-chip talk-mono">
          {RUN_COPY.statusChip(run.status, run.elapsedMs)}
        </span>
      </div>
      {second ? <div className="runs-pane-row-now talk-mono">{second}</div> : null}
      {blocked ? (
        <button
          type="button"
          className="runs-pane-answer"
          onClick={() => {
            // Scroll the card into view and focus it. The drawer row is a
            // pointer to the answer surface, not a second one — §4.5 keeps the
            // question in exactly one place so the two cannot disagree.
            const el = document.getElementById(`run-card-${run.jobId}`);
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el?.focus({ preventScroll: true });
          }}
        >
          Answer
        </button>
      ) : null}
    </li>
  );
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}

function shortLabel(jobId: string): string {
  return jobId.length > 12 ? jobId.slice(0, 12) : jobId;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="right-drawer-section">
      <h3 className="right-drawer-section-title">{title}</h3>
      {children}
    </section>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <div className="right-drawer-empty">{children}</div>;
}

function ToolStreamRow({ entry }: { entry: ToolStreamEntry }) {
  const dot = entry.status === 'running' ? '●' : entry.status === 'ok' ? '✓' : '✗';
  const dotClass = `tool-stream-dot tool-stream-dot--${entry.status}`;
  return (
    <li className="tool-stream-row">
      <span className={dotClass} aria-hidden="true">
        {dot}
      </span>
      <span className="tool-stream-name">{entry.toolName}</span>
      {entry.durationMs !== undefined ? (
        <span className="tool-stream-duration">{formatDuration(entry.durationMs)}</span>
      ) : null}
    </li>
  );
}

function NotificationRow({ notification }: { notification: DrawerNotification }) {
  const navigate = useNavigate();
  return (
    <li className="notification-row">
      <button
        type="button"
        className="notification-button"
        onClick={() => navigate(notification.deepLink)}
      >
        <span className="notification-summary">{notification.summary}</span>
        <span className="notification-time">{formatRelative(notification.receivedAt)}</span>
      </button>
    </li>
  );
}

function UsageBlock({ usage }: { usage: UsageState }) {
  return (
    <dl className="usage-block">
      <div className="usage-row">
        <dt>Input</dt>
        <dd>{formatTokens(usage.inputTokens)}</dd>
      </div>
      <div className="usage-row">
        <dt>Output</dt>
        <dd>{formatTokens(usage.outputTokens)}</dd>
      </div>
      <div className="usage-row">
        <dt>Cost</dt>
        <dd>{formatCost(usage.estimatedCostUsd)}</dd>
      </div>
    </dl>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(ms < 10_000 ? 1 : 0);
  return `${s}s`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

function formatRelative(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
