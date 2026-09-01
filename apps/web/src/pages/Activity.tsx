import { useQuery } from '@tanstack/react-query';
import { Button, Empty, Select, Spin, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  type ActivityDetail,
  type ActivityGroup,
  type ActivityKind,
  type ActivityRow,
  type ActivityTypeFilter,
  buildGroups,
  convertHistoryItem,
  convertSseEvent,
  groupMatchesFilter,
  mergeRows,
} from '../lib/activityFeed';
import { rpc } from '../rpc';
import { subscribeToActivity } from '../sse';

// The activity feed reads TWO sources and shows one timeline:
//
//   • `activity.history` — durable rows out of `observability.db`. This is the
//     authority: it survives a restart, because it was never held in memory.
//     Seeded on mount and on scope change, paged backwards by "load older".
//   • `/sse/activity` — one merged live connection for the whole scope, so a
//     per-agent view costs the same single EventSource as the global one no
//     matter how many sessions that agent has open.
//
// Scope comes from the ROUTE, not from a picker: `/p/:personalityId/activity`
// shows that agent, the bare `/activity` shows every agent. That is the same
// altitude convention `extractWorkspacePersonalityId` encodes, read here off
// `useParams` rather than re-derived from the pathname.
//
// The session `<Select>` is a pure client-side filter over the merged list —
// it decides what you LOOK at, never what is live. Nothing that varies per
// render (the sessions array, the merged rows) may enter the subscription
// effect's dependencies: that is what made the old page tear down and reopen
// its EventSource on every background refetch, losing every event in the gap.

const PAGE_SIZE = 50;

/**
 * Resume cursor for the live stream, deliberately MODULE-level rather than a
 * `useRef`: a ref dies with the component, so navigating away from Activity
 * and back would restart the stream from "now" — exactly the gap this is here
 * to close. The activity buffer is one shared bucket scoped at read time, so a
 * seq learned under any scope is a valid resume point under any other. If the
 * server restarts its buffer seq goes backwards and the replay comes back
 * empty, which is harmless: the live handler on the server side is not
 * seq-filtered, and a mount always re-seeds from durable `activity.history`
 * anyway.
 */
let lastActivitySeq = 0;

const TYPE_FILTERS: Array<{ value: ActivityTypeFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'tools', label: 'Tools' },
  { value: 'turns', label: 'Turns' },
  { value: 'errors', label: 'Errors' },
  { value: 'approvals', label: 'Approvals' },
  { value: 'cron', label: 'Cron' },
];

const DOT_CLASS_MAP: Record<ActivityKind, string> = {
  tool_start: 'tool_start',
  tool_end: 'tool_end',
  done: 'done',
  error: 'error',
  approval: 'approval',
  cron: 'cron',
  notice: 'notice',
};

const TAG_COLORS: Record<ActivityKind, string> = {
  tool_start: 'blue',
  tool_end: 'blue',
  done: 'green',
  error: 'red',
  approval: 'orange',
  cron: 'purple',
  notice: 'default',
};

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function TruncatedPre({ text, maxLen = 400 }: { text: string; maxLen?: number }) {
  const truncated = text.length > maxLen;
  return <pre className="aed-pre">{truncated ? `${text.slice(0, maxLen)}…` : text}</pre>;
}

function ArgsBlock({ args }: { args: unknown }) {
  if (typeof args !== 'object' || args === null) {
    return <TruncatedPre text={String(args)} />;
  }
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return <span className="aed-empty">—</span>;
  return (
    <div className="aed-nested">
      {entries.map(([k, v]) => (
        <div key={k} className="aed-row">
          <span className="aed-key">{k}</span>
          <span className="aed-val">
            {typeof v === 'object' ? (
              <pre className="aed-pre">{JSON.stringify(v, null, 2)}</pre>
            ) : (
              <TruncatedPre text={String(v)} />
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function EventDetail({ details }: { details: ActivityDetail[] }) {
  if (details.length === 0) return null;
  return (
    <div className="activity-event-detail">
      {details.map((row) => (
        <div key={row.key} className="aed-row">
          <span className="aed-key">{row.key}</span>
          <span className="aed-val">
            {row.kind === 'args' ? (
              <ArgsBlock args={row.args} />
            ) : row.kind === 'pre' ? (
              <TruncatedPre text={row.text} />
            ) : (
              row.value
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Activity() {
  const { personalityId: routePersonalityId } = useParams<{ personalityId?: string }>();
  const personalityId = routePersonalityId ?? null;

  const [rows, setRows] = useState<Map<string, ActivityRow>>(() => new Map());
  // Both halves of the page cursor. The timestamp alone cannot resume inside a
  // group of rows sharing one millisecond — the id breaks the tie.
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [nextBeforeId, setNextBeforeId] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [typeFilter, setTypeFilter] = useState<ActivityTypeFilter>('all');
  const [sessionFilter, setSessionFilter] = useState<string | null>(null);
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);

  const historyQuery = useQuery({
    queryKey: ['activity', 'history', personalityId],
    queryFn: () =>
      rpc.activity.history({
        ...(personalityId ? { personalityId } : {}),
        limit: PAGE_SIZE,
      }),
  });

  // Titles for group headers and the filter dropdown — nothing here decides
  // what is live.
  const sessionsQuery = useQuery({
    queryKey: ['sessions', 'list', { personalityId, limit: PAGE_SIZE }],
    queryFn: () =>
      rpc.sessions.list({
        ...(personalityId ? { personalityId } : {}),
        limit: PAGE_SIZE,
      }),
  });
  const sessionOptions = useMemo(
    () =>
      (sessionsQuery.data?.items ?? []).map((s) => ({
        value: s.id,
        label: s.title || s.id.slice(0, 12),
      })),
    [sessionsQuery.data],
  );
  const sessionTitles = useMemo(
    () => new Map((sessionsQuery.data?.items ?? []).map((s) => [s.id, s.title])),
    [sessionsQuery.data],
  );

  // Scope change: drop everything the previous agent's feed accumulated. The
  // live cursor is NOT reset — the buffer's seq is one global sequence, so
  // carrying it across means the new scope resumes without a gap instead of
  // replaying the whole buffer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on personalityId only — the effect body doesn't read it, it's the reset trigger
  useEffect(() => {
    setRows(new Map());
    setNextBefore(null);
    setNextBeforeId(null);
    setSessionFilter(null);
    setExpandedGroupId(null);
    setExpandedRowKey(null);
  }, [personalityId]);

  useEffect(() => {
    const page = historyQuery.data;
    if (!page) return;
    setRows((prev) => mergeRows(prev, page.items.map(convertHistoryItem)));
    setNextBefore(page.nextBefore);
    setNextBeforeId(page.nextBeforeId);
  }, [historyQuery.data]);

  useEffect(() => {
    const sub = subscribeToActivity(personalityId, {
      sinceSeq: lastActivitySeq,
      onEvent: (envelope, seq) => {
        lastActivitySeq = Math.max(lastActivitySeq, seq);
        const row = convertSseEvent(envelope.event, {
          sessionId: envelope.sessionId,
          personalityId: envelope.personalityId,
          seq,
          timestamp: Date.now(),
        });
        if (row) setRows((prev) => mergeRows(prev, [row]));
      },
    });
    return () => sub.close();
  }, [personalityId]);

  const loadOlder = useCallback(async () => {
    if (nextBefore === null) return;
    setLoadingOlder(true);
    try {
      const page = await rpc.activity.history({
        ...(personalityId ? { personalityId } : {}),
        limit: PAGE_SIZE,
        before: nextBefore,
        ...(nextBeforeId === null ? {} : { beforeId: nextBeforeId }),
      });
      setRows((prev) => mergeRows(prev, page.items.map(convertHistoryItem)));
      setNextBefore(page.nextBefore);
      setNextBeforeId(page.nextBeforeId);
    } finally {
      setLoadingOlder(false);
    }
  }, [nextBefore, nextBeforeId, personalityId]);

  const groups = useMemo(() => buildGroups(rows.values()), [rows]);
  const filtered = useMemo(
    () =>
      groups.filter(
        (group) =>
          groupMatchesFilter(group, typeFilter) &&
          (sessionFilter === null || group.sessionId === sessionFilter),
      ),
    [groups, typeFilter, sessionFilter],
  );

  // Per-session context anatomy still needs exactly one session to be about,
  // so it rides the session filter rather than an implicit "most recent".
  const { data: anatomyData } = useQuery({
    queryKey: ['sessions', 'contextAnatomy', sessionFilter],
    queryFn: () => rpc.sessions.contextAnatomy({ id: sessionFilter ?? '' }),
    enabled: sessionFilter !== null,
  });
  const anatomy = anatomyData?.anatomy ?? null;

  if (historyQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }

  return (
    <div className="activity-page">
      <header className="activity-toolbar">
        <Typography.Title level={4} style={{ margin: 0 }}>
          Activity
        </Typography.Title>
        <Select
          allowClear
          placeholder="All sessions"
          size="small"
          style={{ width: 220 }}
          value={sessionFilter}
          onChange={(v) => setSessionFilter(v ?? null)}
          options={sessionOptions}
        />
      </header>

      {anatomy && (
        <div className="activity-context-anatomy">
          <span className="aca-title">Context</span>
          <Tag>system {anatomy.system.toLocaleString()}</Tag>
          <Tag>tools {anatomy.tools.toLocaleString()}</Tag>
          <Tag>messages {anatomy.messages.toLocaleString()}</Tag>
          <Tag color="blue">total {anatomy.total.toLocaleString()} tok</Tag>
          <Tag color="green">cache {Math.round(anatomy.cacheHitRate * 100)}%</Tag>
        </div>
      )}

      <div className="activity-filter-bar">
        {TYPE_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            className={`activity-filter-chip${typeFilter === f.value ? ' active' : ''}`}
            onClick={() => setTypeFilter(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="activity-timeline">
        {filtered.length === 0 ? (
          <Empty description="No activity yet. Events appear as agents work." />
        ) : (
          filtered.map((group) => (
            <ActivityGroupRow
              key={group.id}
              group={group}
              title={group.sessionId === null ? null : (sessionTitles.get(group.sessionId) ?? null)}
              expanded={expandedGroupId === group.id}
              expandedRowKey={expandedRowKey}
              onToggle={() => setExpandedGroupId(expandedGroupId === group.id ? null : group.id)}
              onToggleRow={(key) => setExpandedRowKey(expandedRowKey === key ? null : key)}
            />
          ))
        )}
      </div>

      {nextBefore !== null && (
        <div className="activity-load-older">
          <Button size="small" loading={loadingOlder} onClick={() => void loadOlder()}>
            Load older
          </Button>
        </div>
      )}
    </div>
  );
}

function ActivityGroupRow({
  group,
  title,
  expanded,
  expandedRowKey,
  onToggle,
  onToggleRow,
}: {
  group: ActivityGroup;
  title: string | null;
  expanded: boolean;
  expandedRowKey: string | null;
  onToggle: () => void;
  onToggleRow: (key: string) => void;
}) {
  const toolCount = group.rows.filter(
    (r) => r.label === 'tool_start' || r.label === 'tool_end',
  ).length;
  const hasError = group.rows.some((r) => r.kind === 'error');
  const session = title || group.sessionId?.slice(0, 8) || 'system';
  const toolPart = toolCount > 0 ? ` · ${toolCount} tool call${toolCount === 1 ? '' : 's'}` : '';
  const turnPart = group.turnCount === null ? '' : ` · Turn ${group.turnCount}`;
  const state = group.isLive ? 'live' : hasError ? 'error' : 'done';

  return (
    <div className="activity-group">
      <button
        type="button"
        className={`activity-group-header${expanded ? ' activity-group-header--expanded' : ''}`}
        onClick={onToggle}
      >
        <div className="activity-group-meta">
          <span
            className={`activity-event-dot activity-event-dot--${group.isLive ? 'tool_start' : hasError ? 'error' : 'done'}${group.isLive ? ' activity-event-dot--pulse' : ''}`}
          />
          <span className="activity-group-time">{formatRelative(group.startedAt)}</span>
          <Tag color={group.isLive ? 'processing' : hasError ? 'red' : 'green'}>{state}</Tag>
          <span className="activity-group-summary">{`${session}${turnPart}${toolPart}`}</span>
        </div>
        <span className="activity-group-chevron">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="activity-group-events">
          {group.rows.map((row) => (
            <div key={row.key}>
              <button
                type="button"
                className={`activity-subevent${expandedRowKey === row.key ? ' activity-subevent--expanded' : ''}`}
                onClick={() => onToggleRow(row.key)}
              >
                <span
                  className={`activity-event-dot activity-event-dot--${DOT_CLASS_MAP[row.kind]}`}
                />
                <Tag color={TAG_COLORS[row.kind]} style={{ fontSize: 11, lineHeight: '18px' }}>
                  {row.label}
                </Tag>
                <span className="activity-subevent-summary">{row.summary}</span>
              </button>
              {expandedRowKey === row.key && <EventDetail details={row.details} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
