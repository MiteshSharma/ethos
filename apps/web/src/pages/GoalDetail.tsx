import { Button, Input, Spin, Typography } from 'antd';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ExecutionGraph } from '../components/goals/ExecutionGraph';
import { GoalOutputModal } from '../components/goals/GoalOutputModal';
import { useGoalCancel, useGoalResume, useGoalSteer } from '../features/goals/api/mutations';
import { useGoalDetail } from '../features/goals/api/queries';

// --- Status config --------------------------------------------------------

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
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'exhausted']);

// --- Helpers --------------------------------------------------------------

function formatDuration(startedAt: number, completedAt: number | null): string {
  const end = completedAt ?? Date.now();
  const ms = end - startedAt;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

function formatTokens(n: number | null): string {
  if (n == null) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// --- Component ------------------------------------------------------------

export function GoalDetail() {
  const { goalId = '' } = useParams<{ goalId: string }>();
  const navigate = useNavigate();

  const { data, isLoading, error } = useGoalDetail(goalId);
  const cancelMutation = useGoalCancel(goalId);
  const resumeMutation = useGoalResume(goalId);
  const steerMutation = useGoalSteer(goalId);

  const [steerText, setSteerText] = useState('');
  const [journeyOpen, setJourneyOpen] = useState(true);
  const [outputModalOpen, setOutputModalOpen] = useState(false);

  const handleSteer = useCallback(() => {
    if (!steerText.trim()) return;
    steerMutation.mutate(steerText.trim());
    setSteerText('');
  }, [steerText, steerMutation]);

  const goal = data?.goal;
  const events = data?.events ?? [];
  const attempts = data?.attempts ?? [];

  const isActive = goal ? ACTIVE_STATUSES.has(goal.status) : false;
  const isTerminal = goal ? TERMINAL_STATUSES.has(goal.status) : false;

  const latestAttempt = useMemo(() => {
    if (attempts.length === 0) return null;
    return attempts.reduce((a, b) => (a.n > b.n ? a : b));
  }, [attempts]);

  // Filter events for journey graph — skip noisy 'usage' events
  const journeyEvents = useMemo(() => events.filter((e) => e.eventType !== 'usage'), [events]);

  if (isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 300 }}>
        <Spin />
      </div>
    );
  }

  if (error || !goal) {
    return (
      <div style={{ padding: '24px 32px' }}>
        <Typography.Text type="danger">
          {error ? `Failed to load goal: ${(error as Error).message}` : 'Goal not found'}
        </Typography.Text>
      </div>
    );
  }

  const isLimitHit = goal.status === 'interrupted' && /limit/i.test(goal.errorText ?? '');
  const isCompleted = goal.status === 'completed';
  // only completed goals with real outputMd get Full Analysis
  const hasFullAnalysis = isCompleted && !!goal.outputMd;
  const outputHeading = goal.status === 'failed' ? 'FAILURE' : 'OUTPUT';
  const bodyText = isCompleted
    ? goal.outputMd || goal.outputPartial || '(no output)'
    : goal.outputPartial?.trim()
      ? goal.outputPartial
      : '(no output)';
  const cfg = isLimitHit
    ? { color: 'var(--warning)', label: 'Limit hit', icon: '✗' }
    : (STATUS_CONFIG[goal.status] ?? {
        color: 'var(--text-secondary)',
        label: goal.status,
        icon: '?',
      });

  return (
    <div className="goal-detail-tab">
      {/* ---- Goal bar (row 1) ---- */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 32px',
          borderBottom: '1px solid var(--border-subtle)',
          gap: 16,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 4,
            }}
          >
            <button
              type="button"
              onClick={() => navigate(`/p/${goal.personalityId}/goals`)}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-tertiary)',
                cursor: 'pointer',
                padding: 0,
                fontSize: 13,
              }}
            >
              Goals
            </button>
            <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>/</span>
            <span
              style={{
                fontSize: 10,
                fontWeight: 500,
                color: 'var(--text-tertiary)',
                textTransform: 'uppercase' as const,
                letterSpacing: '0.08em',
              }}
            >
              GOAL
            </span>
          </div>
          <h1
            style={{
              fontSize: 16,
              fontWeight: 500,
              margin: 0,
              color: 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {goal.title || goal.goalText}
          </h1>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexShrink: 0,
          }}
        >
          {/* Attempt indicator */}
          {attempts.length > 0 && (
            <span
              style={{
                fontSize: 12,
                color: 'var(--text-secondary)',
                fontFamily: "'Geist Mono', monospace",
              }}
            >
              Attempt {latestAttempt?.n ?? 1} of {goal.maxAttempts}
              {latestAttempt?.verdict != null && (
                <span style={{ marginLeft: 6 }}>
                  · {Math.round(latestAttempt.verdict.score * 100)}%
                </span>
              )}
            </span>
          )}

          {/* Status pill */}
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '4px 12px',
              borderRadius: 9999,
              fontSize: 12,
              fontWeight: 500,
              color: cfg.color,
              background: `color-mix(in srgb, ${cfg.color} 15%, transparent)`,
            }}
          >
            {isActive ? (
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

          {/* Action buttons */}
          {isActive && (
            <Button
              size="small"
              danger
              onClick={() => cancelMutation.mutate()}
              loading={cancelMutation.isPending}
            >
              Cancel
            </Button>
          )}
          {(goal.status === 'failed' ||
            goal.status === 'cancelled' ||
            goal.status === 'interrupted') && (
            <Button
              size="small"
              type="primary"
              onClick={() => resumeMutation.mutate()}
              loading={resumeMutation.isPending}
            >
              Resume
            </Button>
          )}
        </div>
      </div>

      {/* ---- Middle scrollable row (output + journey) (row 2) ---- */}
      <div
        style={{
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* ---- Output section (visible when terminal) ---- */}
        {isTerminal && (
          <div style={{ padding: '24px 32px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 16,
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 500,
                  color: goal.status === 'failed' ? 'var(--error)' : 'var(--text-tertiary)',
                  textTransform: 'uppercase' as const,
                  letterSpacing: '0.08em',
                }}
              >
                {outputHeading}
              </span>
              {goal.completedAt && (
                <span
                  style={{
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    fontFamily: "'Geist Mono', monospace",
                  }}
                >
                  · {formatDuration(goal.startedAt, goal.completedAt)} elapsed
                </span>
              )}
              {hasFullAnalysis && (
                <button
                  type="button"
                  onClick={() => setOutputModalOpen(true)}
                  style={{
                    marginLeft: 'auto',
                    background: 'none',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 4,
                    color: 'var(--text-secondary)',
                    fontSize: 12,
                    padding: '4px 10px',
                    cursor: 'pointer',
                  }}
                >
                  Full Analysis
                </button>
              )}
            </div>

            {/* Error banner for failed/cancelled goals */}
            {goal.errorText && (
              <div
                style={{
                  padding: '10px 14px',
                  marginBottom: 16,
                  borderRadius: 8,
                  background: 'rgba(248,113,113,0.08)',
                  border: '1px solid rgba(248,113,113,0.2)',
                  color: 'var(--error)',
                  fontSize: 13,
                  fontFamily: "'Geist Mono', monospace",
                }}
              >
                {goal.errorText}
              </div>
            )}

            {!isCompleted && goal.outputPartial && (
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 500,
                  color: 'var(--text-tertiary)',
                  textTransform: 'uppercase' as const,
                  letterSpacing: '0.08em',
                  marginBottom: 6,
                }}
              >
                Partial output
              </div>
            )}

            <div style={{ display: 'flex', gap: 24 }}>
              {/* Left: output text */}
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: '16px 20px',
                  borderRadius: 8,
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-elevated)',
                  fontSize: 14,
                  lineHeight: 1.6,
                  color: 'var(--text-primary)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 500,
                  overflowY: 'auto',
                }}
              >
                {bodyText}
              </div>

              {/* Right: verdict */}
              {latestAttempt?.verdict && (
                <div style={{ width: 220, flexShrink: 0 }}>
                  <div
                    style={{
                      padding: '12px 14px',
                      borderRadius: 8,
                      border: '1px solid var(--border-subtle)',
                      background: 'var(--bg-elevated)',
                    }}
                  >
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 500,
                        color: 'var(--text-tertiary)',
                        textTransform: 'uppercase' as const,
                        letterSpacing: '0.08em',
                        marginBottom: 8,
                      }}
                    >
                      Judge Verdict
                    </div>
                    <div
                      style={{
                        fontSize: 20,
                        fontWeight: 600,
                        color:
                          latestAttempt.verdict.score >= 0.8 ? 'var(--success)' : 'var(--warning)',
                        marginBottom: 10,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {Math.round(latestAttempt.verdict.score * 100)}%
                    </div>
                    {latestAttempt.verdict.perCriterion.map((c) => (
                      <div
                        key={c.id}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 6,
                          marginBottom: 6,
                          fontSize: 12,
                          lineHeight: 1.4,
                        }}
                      >
                        <span
                          style={{
                            color:
                              c.pass || (c.score != null && c.score >= 0.8)
                                ? 'var(--success)'
                                : 'var(--error)',
                            flexShrink: 0,
                            marginTop: 1,
                          }}
                        >
                          {c.pass || (c.score != null && c.score >= 0.8) ? '✓' : '✗'}
                        </span>
                        <span
                          style={{
                            color: 'var(--text-secondary)',
                          }}
                        >
                          {c.evidence}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ---- Journey section ---- */}
        <div
          style={{
            padding: '0 32px 32px 32px',
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <button
            type="button"
            onClick={() => setJourneyOpen((v) => !v)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '12px 0',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-primary)',
              width: '100%',
            }}
          >
            <span
              style={{
                fontSize: 10,
                fontWeight: 500,
                color: 'var(--text-tertiary)',
                textTransform: 'uppercase' as const,
                letterSpacing: '0.08em',
              }}
            >
              JOURNEY
            </span>
            <span
              style={{
                fontSize: 12,
                color: 'var(--text-secondary)',
              }}
            >
              Execution trace
            </span>
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 12,
                color: 'var(--text-tertiary)',
                transform: journeyOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 180ms cubic-bezier(0.16, 1, 0.3, 1)',
              }}
            >
              &#x25B8;
            </span>
          </button>

          {journeyOpen && (
            <div style={{ flex: 1, minHeight: 0 }}>
              <ExecutionGraph
                events={journeyEvents}
                goalId={goalId}
                goalText={goal.goalText}
                personalityId={goal.personalityId}
                isActive={isActive}
              />
            </div>
          )}
        </div>
      </div>

      {/* ---- Steer composer (only while active) ---- */}
      {isActive && (
        <div style={{ padding: '0 32px', marginBottom: 16 }}>
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
            }}
          >
            <Input
              value={steerText}
              onChange={(e) => setSteerText(e.target.value)}
              placeholder="Steer this goal — add context or redirect..."
              onPressEnter={handleSteer}
              style={{ flex: 1 }}
            />
            <Button
              type="primary"
              onClick={handleSteer}
              loading={steerMutation.isPending}
              disabled={!steerText.trim()}
            >
              Steer
            </Button>
          </div>
        </div>
      )}

      {/* ---- Stats footer ---- */}
      <div
        style={{
          padding: '12px 32px',
          borderTop: '1px solid var(--border-subtle)',
          fontSize: 12,
          fontFamily: "'Geist Mono', monospace",
          color: 'var(--text-tertiary)',
          fontVariantNumeric: 'tabular-nums',
          display: 'flex',
          gap: 4,
          flexWrap: 'wrap',
        }}
      >
        <span>{goal.turnCount ?? 0} turns</span>
        <span>·</span>
        <span>{goal.toolCount ?? 0} tool calls</span>
        <span>·</span>
        <span>{formatTokens(goal.tokenCount)} tokens</span>
        <span>·</span>
        <span>{goal.costUsd != null ? `$${goal.costUsd.toFixed(2)}` : '$0.00'}</span>
        <span>·</span>
        <span>{formatDuration(goal.startedAt, goal.completedAt)} elapsed</span>
      </div>

      {hasFullAnalysis && (
        <GoalOutputModal
          open={outputModalOpen}
          onClose={() => setOutputModalOpen(false)}
          title={goal.title || goal.goalText}
          personalityId={goal.personalityId}
          outputMd={goal.outputMd ?? ''}
        />
      )}

      {/* Pulse animation */}
      <style>{`
        @keyframes goals-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
