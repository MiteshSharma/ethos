import { Spin, Typography } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { useGoalsList } from '../features/goals/api/queries';
import { filterGoalsByPersonality } from '../lib/workspaceScope';

const STATUS_CONFIG: Record<string, { color: string; label: string; icon: string }> = {
  planning: { color: '#14B8A6', label: 'Planning', icon: '⏳' },
  running: { color: 'var(--info)', label: 'Running', icon: '⏳' },
  judging: { color: 'var(--info)', label: 'Judging', icon: '⏳' },
  retrying: { color: 'var(--info)', label: 'Retrying', icon: '⏳' },
  needs_clarification: {
    color: 'var(--warning)',
    label: 'Needs Input',
    icon: '⏳',
  },
  completed: { color: 'var(--success)', label: 'Completed', icon: '✓' },
  failed: { color: 'var(--error)', label: 'Failed', icon: '✗' },
  cancelled: {
    color: 'var(--text-tertiary)',
    label: 'Cancelled',
    icon: '—',
  },
  interrupted: {
    color: 'var(--warning)',
    label: 'Interrupted',
    icon: '✗',
  },
  exhausted: { color: 'var(--warning)', label: 'Exhausted', icon: '✗' },
};

const ACTIVE_STATUSES = new Set([
  'planning',
  'running',
  'judging',
  'retrying',
  'needs_clarification',
]);

function formatDuration(startedAt: number, completedAt: number | null): string {
  const end = completedAt ?? Date.now();
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

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function Goals() {
  const { data, isLoading, error } = useGoalsList();
  const navigate = useNavigate();
  // P2: `goals.list()` has no `personalityId` input, so this pane filters
  // client-side — `GoalSchema.personalityId` is on every row already. The
  // bare `/goals` URL always redirects into a workspace (P1a), so
  // `personalityId` is undefined only for routes this page never actually
  // renders at today.
  const { personalityId } = useParams<{ personalityId?: string }>();

  if (isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }

  if (error) {
    return (
      <Typography.Text type="danger">
        Failed to load goals: {(error as Error).message}
      </Typography.Text>
    );
  }

  const allGoals = personalityId
    ? filterGoalsByPersonality(data?.goals ?? [], personalityId)
    : (data?.goals ?? []);
  const sorted = [...allGoals].sort((a, b) => {
    const aActive = ACTIVE_STATUSES.has(a.status) ? 0 : 1;
    const bActive = ACTIVE_STATUSES.has(b.status) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return b.startedAt - a.startedAt;
  });

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1100 }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 24,
        }}
      >
        <h1
          style={{
            fontSize: 24,
            fontWeight: 600,
            margin: 0,
            color: 'var(--text-primary)',
          }}
        >
          Goals
        </h1>
        <span
          style={{
            fontSize: 12,
            color: 'var(--text-secondary)',
            fontFamily: "'Geist Mono', monospace",
          }}
        >
          {allGoals.length} {allGoals.length === 1 ? 'goal' : 'goals'}
        </span>
      </header>

      {sorted.length === 0 ? (
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
          No goals yet. Use Send as Goal in a chat to start one.
        </div>
      ) : (
        <div
          style={{
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          {/* Table header */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 120px 110px 130px 80px 70px',
              padding: '8px 16px',
              background: 'var(--bg-elevated)',
              borderBottom: '1px solid var(--border-subtle)',
              fontSize: 11,
              fontWeight: 500,
              color: 'var(--text-tertiary)',
              textTransform: 'uppercase' as const,
              letterSpacing: '0.08em',
            }}
          >
            <span>Goal</span>
            <span>Personality</span>
            <span>Status</span>
            <span>Started</span>
            <span>Duration</span>
            <span style={{ textAlign: 'right' }}>Cost</span>
          </div>

          {/* Table rows */}
          {sorted.map((goal) => {
            const cfg = STATUS_CONFIG[goal.status] ?? {
              color: 'var(--text-secondary)',
              label: goal.status,
              icon: '?',
            };
            return (
              <button
                key={goal.id}
                type="button"
                onClick={() => navigate(`/p/${goal.personalityId}/goals/${goal.id}`)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 120px 110px 130px 80px 70px',
                  padding: '10px 16px',
                  background: 'none',
                  border: 'none',
                  borderBottom: '1px solid var(--border-subtle)',
                  width: '100%',
                  textAlign: 'left',
                  cursor: 'pointer',
                  color: 'var(--text-primary)',
                  fontSize: 13,
                  alignItems: 'center',
                  transition: 'background-color 80ms',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'var(--bg-overlay)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    paddingRight: 12,
                  }}
                >
                  {truncate(goal.title || goal.goalText, 60)}
                </span>
                <span
                  style={{
                    color: 'var(--text-secondary)',
                    fontFamily: "'Geist Mono', monospace",
                    fontSize: 12,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {goal.personalityId}
                </span>
                <span>
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
                    {ACTIVE_STATUSES.has(goal.status) ? (
                      <span
                        style={{
                          display: 'inline-block',
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: cfg.color,
                          animation: 'goals-pulse 1.5s ease-in-out infinite',
                        }}
                      />
                    ) : (
                      <span>{cfg.icon}</span>
                    )}
                    {cfg.label}
                  </span>
                </span>
                <span
                  style={{
                    fontFamily: "'Geist Mono', monospace",
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                  }}
                >
                  {formatTime(goal.startedAt)}
                </span>
                <span
                  style={{
                    fontFamily: "'Geist Mono', monospace",
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {formatDuration(goal.startedAt, goal.completedAt)}
                </span>
                <span
                  style={{
                    fontFamily: "'Geist Mono', monospace",
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {goal.costUsd != null ? `$${goal.costUsd.toFixed(2)}` : '—'}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Pulse animation for active status dots */}
      <style>{`
        @keyframes goals-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
