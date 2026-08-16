import type { BackgroundJobEventWire, BackgroundJobStatusWire } from '@ethosagent/web-contracts';
import { Drawer, Empty, Popconfirm, Select, Spin, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useRecentSessions } from '../features/sessions/api/queries';
import { useTaskCancel } from '../features/tasks/api/mutations';
import { useTaskDetail, useTasksList } from '../features/tasks/api/queries';
import {
  filterSessionsByPersonality,
  filterTasksForLibrary,
  filterTasksForWorkspace,
} from '../lib/workspaceScope';

const STATUS_CONFIG: Record<BackgroundJobStatusWire, { color: string; label: string }> = {
  queued: { color: 'var(--info)', label: 'Queued' },
  running: { color: 'var(--info)', label: 'Running' },
  done: { color: 'var(--success)', label: 'Done' },
  failed: { color: 'var(--error)', label: 'Failed' },
  aborted: { color: 'var(--warning)', label: 'Aborted' },
  stale: { color: 'var(--warning)', label: 'Stale' },
  expired: { color: 'var(--text-tertiary)', label: 'Expired' },
};

// Only queued/running jobs are cancelable; every other state is terminal.
const CANCELABLE: ReadonlySet<BackgroundJobStatusWire> = new Set<BackgroundJobStatusWire>([
  'queued',
  'running',
]);
const ACTIVE: ReadonlySet<BackgroundJobStatusWire> = new Set<BackgroundJobStatusWire>([
  'queued',
  'running',
]);

const mono = "'Geist Mono', monospace";

function formatDuration(startedAt: number | null, finishedAt: number | null): string {
  if (startedAt == null) return '—';
  const end = finishedAt ?? Date.now();
  const ms = end - startedAt;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

function formatFreshness(ts: number | null): string {
  if (ts == null) return '—';
  const diff = Date.now() - ts;
  if (diff < 10_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function formatTime(ts: number | null): string {
  if (ts == null) return '—';
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const GRID = '1fr 110px 100px 130px 90px 90px 80px 84px';

const CELL_MUTED: React.CSSProperties = {
  fontFamily: mono,
  fontSize: 12,
  color: 'var(--text-secondary)',
  fontVariantNumeric: 'tabular-nums',
};

function StatusChip({ status }: { status: BackgroundJobStatusWire }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 9999,
        fontSize: 11,
        fontWeight: 500,
        color: cfg.color,
        background: `color-mix(in srgb, ${cfg.color} 15%, transparent)`,
      }}
    >
      {ACTIVE.has(status) ? (
        <span
          style={{
            display: 'inline-block',
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: cfg.color,
            animation: 'tasks-pulse 1.5s ease-in-out infinite',
          }}
        />
      ) : null}
      {cfg.label}
    </span>
  );
}

function EventTrail({ events }: { events: BackgroundJobEventWire[] }) {
  if (events.length === 0) {
    return <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>No events yet.</span>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {events.map((ev) => {
        const payload = Object.keys(ev.payload).length > 0 ? JSON.stringify(ev.payload) : null;
        return (
          <div
            key={ev.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '52px 140px 1fr',
              gap: 8,
              alignItems: 'baseline',
              padding: '4px 0',
              borderBottom: '1px solid var(--border-subtle)',
            }}
          >
            <span style={{ ...CELL_MUTED, fontSize: 11 }}>#{ev.seq}</span>
            <span style={{ fontFamily: mono, fontSize: 12, color: 'var(--text-primary)' }}>
              {ev.eventType}
            </span>
            <span style={{ ...CELL_MUTED, wordBreak: 'break-word' }}>
              {formatTime(ev.createdAt)}
              {payload ? ` · ${payload}` : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function TaskDetailDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, isLoading } = useTaskDetail(id);

  return (
    <Drawer
      open={id != null}
      onClose={onClose}
      width={560}
      title={data ? (data.label ?? data.id.slice(0, 12)) : 'Task'}
      styles={{ body: { display: 'flex', flexDirection: 'column', gap: 20 } }}
    >
      {isLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
          <Spin />
        </div>
      ) : !data ? (
        <Empty description="Task not found" />
      ) : (
        <>
          <section style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <StatusChip status={data.status} />
            <span style={CELL_MUTED}>
              {data.personalityId ?? 'no personality'} · depth {data.depth}
            </span>
            <span style={{ ...CELL_MUTED, marginLeft: 'auto' }}>
              ${data.spendUsd.toFixed(2)}
              {data.maxCostUsd != null ? ` / $${data.maxCostUsd.toFixed(2)}` : ''}
            </span>
          </section>

          <section>
            <SectionLabel>Prompt</SectionLabel>
            <pre style={preStyle}>{data.prompt}</pre>
          </section>

          {data.summary != null && (
            <section>
              <SectionLabel>Summary</SectionLabel>
              <pre style={preStyle}>{data.summary}</pre>
            </section>
          )}

          {data.error != null && (
            <section>
              <SectionLabel>Error</SectionLabel>
              <pre style={{ ...preStyle, color: 'var(--error)' }}>{data.error}</pre>
            </section>
          )}

          <section>
            <SectionLabel>Event trail ({data.events.length})</SectionLabel>
            <EventTrail events={data.events} />
          </section>
        </>
      )}
    </Drawer>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 500,
        color: 'var(--text-tertiary)',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

const preStyle: React.CSSProperties = {
  margin: 0,
  padding: 12,
  fontFamily: mono,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--text-primary)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

export function Tasks() {
  // P2/P3: background jobs have no global list (`JobStore` only supports
  // `listByRoot` — see `TasksService.list`), so this pane is session-scoped,
  // one root session at a time, at BOTH altitudes. Workspace (P2) narrows the
  // session PICKER itself to this agent's sessions — so you can't
  // accidentally browse another agent's tasks from here — and client-filters
  // the returned jobs to `personalityId === current`. Library "All tasks"
  // (P3, rendered at `/library/tasks` with no `:personalityId`) leaves the
  // picker unscoped (every session, any agent) and instead filters jobs down
  // to `personalityId === null` — the unscoped rows the workspace pane hides
  // (`filterTasksForWorkspace` / `filterTasksForLibrary` in `workspaceScope.ts`).
  const { personalityId } = useParams<{ personalityId?: string }>();
  const { data: sessionsData, isLoading: sessionsLoading } = useRecentSessions(50);
  const allSessions = useMemo(() => sessionsData?.items ?? [], [sessionsData]);
  const sessions = useMemo(
    () => (personalityId ? filterSessionsByPersonality(allSessions, personalityId) : allSessions),
    [allSessions, personalityId],
  );

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // A manually picked session belongs to whichever agent was active when it
  // was picked — drop it on a workspace switch so a stale, foreign session
  // key can't linger (AltitudeRail keeps you on this pane per P2, but with a
  // fresh personality).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on personalityId only — the effect body doesn't read it, it's the reset trigger
  useEffect(() => {
    setSelectedKey(null);
  }, [personalityId]);
  const rootSessionKey = selectedKey ?? sessions[0]?.key ?? null;

  const { data: rawJobs, isLoading } = useTasksList(rootSessionKey);
  const jobs = useMemo(
    () =>
      personalityId
        ? filterTasksForWorkspace(rawJobs ?? [], personalityId)
        : filterTasksForLibrary(rawJobs ?? []),
    [rawJobs, personalityId],
  );
  const cancelMut = useTaskCancel();
  const [detailId, setDetailId] = useState<string | null>(null);

  const sorted = useMemo(() => {
    return [...jobs].sort((a, b) => {
      const aActive = ACTIVE.has(a.status) ? 0 : 1;
      const bActive = ACTIVE.has(b.status) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return b.createdAt - a.createdAt;
    });
  }, [jobs]);

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1100 }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 24,
        }}
      >
        <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>
          {personalityId ? 'Tasks' : 'All tasks'}
        </h1>
        <Select
          size="small"
          style={{ width: 260 }}
          placeholder="Select a session"
          loading={sessionsLoading}
          value={rootSessionKey}
          onChange={(v) => setSelectedKey(v)}
          options={sessions.map((s) => ({
            value: s.key,
            label: s.title || s.key,
          }))}
        />
      </header>

      <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: -12, marginBottom: 20 }}>
        {personalityId
          ? 'Background jobs are scoped to a single root session. Pick a session above to view its tasks.'
          : 'Unscoped background jobs — spawned outside any personality context — for a single root session. Pick a session above to view its tasks.'}
      </p>

      {isLoading || sessionsLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 160 }}>
          <Spin />
        </div>
      ) : sorted.length === 0 ? (
        <div
          style={{
            padding: '48px 24px',
            textAlign: 'center',
            color: 'var(--text-secondary)',
            fontSize: 14,
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            background: 'var(--bg-elevated)',
          }}
        >
          {rootSessionKey
            ? 'No background jobs for this session yet.'
            : 'No sessions yet — background jobs appear once an agent spawns them.'}
        </div>
      ) : (
        <div
          style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, overflow: 'hidden' }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: GRID,
              padding: '8px 16px',
              background: 'var(--bg-elevated)',
              borderBottom: '1px solid var(--border-subtle)',
              fontSize: 11,
              fontWeight: 500,
              color: 'var(--text-tertiary)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
            }}
          >
            <span>Task</span>
            <span>Personality</span>
            <span>Status</span>
            <span>Started</span>
            <span>Duration</span>
            <span>Heartbeat</span>
            <span style={{ textAlign: 'right' }}>Spend</span>
            <span style={{ textAlign: 'right' }}>Action</span>
          </div>

          {sorted.map((job) => (
            <div
              key={job.id}
              style={{
                display: 'grid',
                gridTemplateColumns: GRID,
                padding: '10px 16px',
                borderBottom: '1px solid var(--border-subtle)',
                alignItems: 'center',
                fontSize: 13,
                color: 'var(--text-primary)',
              }}
            >
              <button
                type="button"
                onClick={() => setDetailId(job.id)}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  textAlign: 'left',
                  cursor: 'pointer',
                  color: 'var(--text-primary)',
                  fontSize: 13,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  paddingRight: 12,
                }}
                title="View task detail"
              >
                {job.label ?? job.id.slice(0, 12)}
              </button>
              <span
                style={{
                  ...CELL_MUTED,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {job.personalityId ?? '—'}
              </span>
              <span>
                <StatusChip status={job.status} />
              </span>
              <span style={CELL_MUTED}>{formatTime(job.startedAt ?? job.createdAt)}</span>
              <span style={CELL_MUTED}>{formatDuration(job.startedAt, job.finishedAt)}</span>
              <span style={CELL_MUTED}>
                {job.status === 'running' ? formatFreshness(job.heartbeatAt) : '—'}
              </span>
              <span style={{ ...CELL_MUTED, textAlign: 'right' }}>${job.spendUsd.toFixed(2)}</span>
              <span style={{ textAlign: 'right' }}>
                {CANCELABLE.has(job.status) ? (
                  <Popconfirm
                    title="Cancel this task?"
                    okText="Cancel task"
                    cancelText="Keep"
                    onConfirm={() => cancelMut.mutate(job.id)}
                  >
                    <button
                      type="button"
                      disabled={cancelMut.isPending}
                      style={{
                        background: 'none',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 6,
                        padding: '2px 10px',
                        fontSize: 12,
                        color: 'var(--error)',
                        cursor: 'pointer',
                      }}
                    >
                      Cancel
                    </button>
                  </Popconfirm>
                ) : (
                  <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>—</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {sorted.length > 0 && (
        <Typography.Text style={{ display: 'block', marginTop: 12, fontSize: 12 }} type="secondary">
          {sorted.length} {sorted.length === 1 ? 'task' : 'tasks'}
        </Typography.Text>
      )}

      <TaskDetailDrawer id={detailId} onClose={() => setDetailId(null)} />

      <style>{`
        @keyframes tasks-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
