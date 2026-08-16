import type {
  MemoryFile,
  MemoryHistoryEntry,
  MemoryStoreId,
  PendingMemory,
} from '@ethosagent/web-contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  DatePicker,
  Input,
  Select,
  Spin,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import type { Dayjs } from 'dayjs';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { PersonalitySelect } from '../components/personality/PersonalitySelect';
import { useFavouritePersonality } from '../hooks/useFavouritePersonality';
import { resolvePersonalityId } from '../lib/favouritePersonality';
import { rpc } from '../rpc';

type MemoryHistorySource = MemoryHistoryEntry['source'];
type MemoryView = 'files' | 'timeline' | 'pending';

export function Memory() {
  const [view, setView] = useState<MemoryView>('files');
  const [activeStore, setActiveStore] = useState<MemoryStoreId>('memory');
  const { personalityId: routePersonalityId } = useParams<{ personalityId?: string }>();
  const [personalityId, setPersonalityId] = useState<string | null>(routePersonalityId ?? null);
  const [userId, setUserId] = useState<string | null>(null);
  const { favouriteId, toggleFavourite } = useFavouritePersonality();

  // P2 (plan/phases/personality-first-ui.md): default to — and stay in sync
  // with — the workspace route's personality rather than the independently-
  // remembered favourite. `resolvePersonalityId` below still lets a manual
  // pick win until the next navigation; switching agents (AltitudeRail) is
  // what re-syncs it, same as every other workspace pane.
  useEffect(() => {
    if (routePersonalityId) setPersonalityId(routePersonalityId);
  }, [routePersonalityId]);

  const personalitiesQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
  });

  const personalities = personalitiesQuery.data?.items ?? [];
  const effectivePersonalityId = resolvePersonalityId({
    selectedId: personalityId,
    favouriteId,
    defaultId: personalitiesQuery.data?.defaultId ?? null,
    available: personalities.map((p) => p.id),
  });

  const usersQuery = useQuery({
    queryKey: ['memory', 'listUsers'],
    queryFn: () => rpc.memory.listUsers({}),
  });

  const listQuery = useQuery({
    queryKey: ['memory', 'list', effectivePersonalityId, activeStore === 'user' ? userId : null],
    queryFn: () =>
      rpc.memory.list({
        personalityId: effectivePersonalityId as string,
        ...(activeStore === 'user' && userId ? { userId } : {}),
      }),
    enabled: !!effectivePersonalityId,
  });

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => rpc.config.get(),
  });

  if (personalitiesQuery.isLoading || (personalitiesQuery.isSuccess && listQuery.isLoading)) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (listQuery.error) {
    return (
      <Typography.Text type="danger">
        Failed to load memory: {(listQuery.error as Error).message}
      </Typography.Text>
    );
  }

  const files = listQuery.data?.items ?? [];
  const fileByStore = new Map(files.map((f) => [f.store, f] as const));
  const memoryMode = configQuery.data?.memory ?? 'markdown';

  const users = usersQuery.data?.users ?? [];

  return (
    <div className="memory-tab">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Personality
        </Typography.Text>
        <PersonalitySelect
          personalities={personalities}
          value={effectivePersonalityId}
          onChange={setPersonalityId}
          loading={personalitiesQuery.isLoading}
          favouriteId={favouriteId}
          onToggleFavourite={toggleFavourite}
        />
        {view === 'files' && activeStore === 'user' ? (
          <>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              User
            </Typography.Text>
            <Select
              size="small"
              style={{ width: 200 }}
              value={userId ?? '__shared__'}
              onChange={(v) => setUserId(v === '__shared__' ? null : v)}
              loading={usersQuery.isLoading}
              options={[
                { value: '__shared__', label: 'Shared (personality default)' },
                ...users.map((u) => ({
                  value: u.userId,
                  label: u.displayLabel,
                })),
              ]}
            />
          </>
        ) : null}
      </div>

      {memoryMode === 'vector' ? (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
          Vector mode is active — the agent uses semantic chunks, not these files. Switch to{' '}
          <code>markdown</code> mode in Settings if you want edits here to flow back to the agent.
        </Typography.Paragraph>
      ) : null}

      <Tabs
        activeKey={view}
        onChange={(k) => setView(k as MemoryView)}
        items={[
          {
            key: 'files',
            label: 'Files',
            children: (
              <Tabs
                activeKey={activeStore}
                onChange={(k) => setActiveStore(k as MemoryStoreId)}
                items={[
                  {
                    key: 'memory',
                    label: 'MEMORY.md',
                    children: effectivePersonalityId ? (
                      <MemoryEditor
                        store="memory"
                        file={fileByStore.get('memory') ?? null}
                        personalityId={effectivePersonalityId}
                      />
                    ) : null,
                  },
                  {
                    key: 'user',
                    label: 'USER.md',
                    children: effectivePersonalityId ? (
                      <MemoryEditor
                        store="user"
                        file={fileByStore.get('user') ?? null}
                        personalityId={effectivePersonalityId}
                        userId={userId ?? undefined}
                      />
                    ) : null,
                  },
                ]}
              />
            ),
          },
          {
            key: 'timeline',
            label: 'Timeline',
            children: effectivePersonalityId ? (
              <MemoryTimeline personalityId={effectivePersonalityId} />
            ) : null,
          },
          {
            key: 'pending',
            label: 'Pending',
            children: effectivePersonalityId ? (
              <MemoryPending personalityId={effectivePersonalityId} />
            ) : null,
          },
        ]}
      />
    </div>
  );
}

function MemoryEditor({
  store,
  file,
  personalityId,
  userId,
}: {
  store: MemoryStoreId;
  file: MemoryFile | null;
  personalityId: string;
  userId?: string;
}) {
  const qc = useQueryClient();
  const { notification, modal } = AntApp.useApp();
  const [draft, setDraft] = useState(file?.content ?? '');
  const [search, setSearch] = useState('');

  useEffect(() => {
    setDraft(file?.content ?? '');
  }, [file]);

  const writeMut = useMutation({
    mutationFn: (content: string) =>
      rpc.memory.write({ store, content, personalityId, ...(userId ? { userId } : {}) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memory', 'list'] });
      notification.success({ message: 'Saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  const dirty = draft !== (file?.content ?? '');
  const matchCount = search ? countMatches(draft, search) : 0;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      notification.info({ message: 'Copied to clipboard', placement: 'topRight' });
    } catch (err) {
      notification.error({ message: 'Copy failed', description: (err as Error).message });
    }
  };

  const onRevert = () => {
    if (!dirty) return;
    modal.confirm({
      title: 'Discard local edits?',
      content: 'Your unsaved changes will be lost.',
      okText: 'Discard',
      okButtonProps: { danger: true },
      onOk: () => setDraft(file?.content ?? ''),
    });
  };

  return (
    <div className="memory-editor">
      <header className="memory-toolbar">
        <span className="memory-meta">
          {file?.path ? (
            <Tooltip title={file.path}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {file.path.replace(/^.+\/(?=[^/]+$)/, '')}
              </Typography.Text>
            </Tooltip>
          ) : null}
          {file?.modifiedAt ? (
            <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
              · edited {formatRelative(file.modifiedAt)}
            </Typography.Text>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
              · not yet written
            </Typography.Text>
          )}
        </span>
        <Input
          placeholder="Search…"
          allowClear
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 220 }}
          suffix={
            search ? (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {matchCount} match{matchCount === 1 ? '' : 'es'}
              </Typography.Text>
            ) : null
          }
        />
      </header>

      <Input.TextArea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        autoSize={{ minRows: 18, maxRows: 36 }}
        style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12.5, marginTop: 12 }}
        placeholder={
          store === 'memory'
            ? '# Project context\n\nNotes the agent reads each turn. Edits land in ~/.ethos/MEMORY.md.'
            : '# About me\n\nWho you are, what you build, how you work. Edits land in ~/.ethos/USER.md.'
        }
      />

      <footer className="memory-actions">
        <Button onClick={onCopy}>Copy</Button>
        <Button onClick={onRevert} disabled={!dirty}>
          Revert
        </Button>
        <Button
          type="primary"
          onClick={() => writeMut.mutate(draft)}
          loading={writeMut.isPending}
          disabled={!dirty}
        >
          Save
        </Button>
      </footer>
    </div>
  );
}

// --- Timeline sub-view -------------------------------------------------------

const HISTORY_PAGE_SIZE = 50;

const SOURCE_LABEL: Record<MemoryHistorySource, string> = {
  tool: 'tool',
  consolidation: 'consolidation',
  dream: 'dream',
  capture: 'capture',
  'web-editor': 'web editor',
  'global-entry': 'global entry',
  restore: 'restore',
};

// Categorical tag colors — antd presets resolve through the ConfigProvider
// theme, so they track light/dark. The label text carries the meaning; color
// is a scan aid, never the sole signal.
const SOURCE_COLOR: Record<MemoryHistorySource, string> = {
  capture: 'blue',
  consolidation: 'orange',
  dream: 'magenta',
  tool: 'default',
  'web-editor': 'green',
  'global-entry': 'default',
  restore: 'gold',
};

const KEY_OPTIONS = [
  { value: '', label: 'All files' },
  { value: 'MEMORY.md', label: 'MEMORY.md' },
  { value: 'USER.md', label: 'USER.md' },
  { value: 'memory-archive.md', label: 'memory-archive.md' },
];

function MemoryTimeline({ personalityId }: { personalityId: string }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [keyFilter, setKeyFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);

  const sinceMs = range ? range[0].startOf('day').valueOf() : undefined;
  const untilMs = range ? range[1].endOf('day').valueOf() : undefined;

  const historyQuery = useInfiniteQuery({
    queryKey: [
      'memory',
      'history',
      personalityId,
      keyFilter || null,
      sourceFilter || null,
      sinceMs ?? null,
      untilMs ?? null,
    ],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      rpc.memory.history({
        personalityId,
        ...(keyFilter ? { key: keyFilter } : {}),
        ...(sourceFilter ? { source: sourceFilter as MemoryHistorySource } : {}),
        ...(sinceMs !== undefined ? { sinceMs } : {}),
        ...(untilMs !== undefined ? { untilMs } : {}),
        limit: HISTORY_PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: !!personalityId,
  });

  const restoreMut = useMutation({
    mutationFn: (slug: string) => rpc.memory.restore({ personalityId, slug }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['memory', 'history', personalityId] });
      qc.invalidateQueries({ queryKey: ['memory', 'list'] });
      notification.success({
        message: `Restored to ${res.restoredTo}`,
        placement: 'topRight',
      });
    },
    onError: (err) =>
      notification.error({ message: 'Restore failed', description: (err as Error).message }),
  });

  const pages = historyQuery.data?.pages ?? [];
  const entries = pages.flatMap((p) => p.entries);
  const corruptLines = pages[0]?.corruptLines ?? 0;

  return (
    <div className="memory-timeline">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          marginBottom: 16,
        }}
      >
        <Select
          size="small"
          style={{ width: 180 }}
          value={keyFilter}
          onChange={setKeyFilter}
          options={KEY_OPTIONS}
        />
        <Select
          size="small"
          style={{ width: 160 }}
          value={sourceFilter}
          onChange={setSourceFilter}
          options={[
            { value: '', label: 'All sources' },
            ...(Object.keys(SOURCE_LABEL) as MemoryHistorySource[]).map((s) => ({
              value: s,
              label: SOURCE_LABEL[s],
            })),
          ]}
        />
        <DatePicker.RangePicker
          size="small"
          value={range}
          onChange={(dates) => {
            const from = dates?.[0];
            const to = dates?.[1];
            setRange(from && to ? [from, to] : null);
          }}
          allowClear
        />
      </div>

      {historyQuery.isLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 160 }}>
          <Spin />
        </div>
      ) : historyQuery.error ? (
        <Typography.Text type="danger">
          Failed to load history: {(historyQuery.error as Error).message}
        </Typography.Text>
      ) : entries.length === 0 ? (
        <Typography.Text type="secondary">
          No memory history yet. Edits, captures, and consolidation runs appear here.
        </Typography.Text>
      ) : (
        <>
          <div>
            {entries.map((e) => (
              <TimelineRow
                key={`${e.ts}-${e.key}-${e.afterHash}`}
                entry={e}
                personalityId={personalityId}
                onRestore={(slug) => restoreMut.mutate(slug)}
                restorePending={restoreMut.isPending}
              />
            ))}
          </div>
          {corruptLines > 0 ? (
            <Typography.Text
              type="warning"
              style={{ fontSize: 12, display: 'block', marginTop: 8 }}
            >
              {corruptLines} corrupt line{corruptLines === 1 ? '' : 's'} skipped.
            </Typography.Text>
          ) : null}
          {historyQuery.hasNextPage ? (
            <div style={{ marginTop: 12 }}>
              <Button
                size="small"
                onClick={() => historyQuery.fetchNextPage()}
                loading={historyQuery.isFetchingNextPage}
              >
                Load more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Extract the archive slug from a `memory-archive.md` add diff (the archive
 *  marker carries `slug=<x>`); null for entries that aren't archive moves. */
function archiveMoveSlug(entry: MemoryHistoryEntry): string | null {
  if (entry.source !== 'consolidation') return null;
  if (entry.key !== 'memory-archive.md') return null;
  if (!entry.actions.includes('add')) return null;
  const match = /slug=([^\s]+)/.exec(entry.diff);
  return match?.[1] ?? null;
}

function TimelineRow({
  entry,
  personalityId,
  onRestore,
  restorePending,
}: {
  entry: MemoryHistoryEntry;
  personalityId: string;
  onRestore: (slug: string) => void;
  restorePending: boolean;
}) {
  const { token } = theme.useToken();
  const [expanded, setExpanded] = useState(false);
  const slug = archiveMoveSlug(entry);

  const blobQuery = useQuery({
    queryKey: ['memory', 'historyBlob', personalityId, entry.blob],
    queryFn: () => rpc.memory.historyBlob({ personalityId, blob: entry.blob as string }),
    enabled: expanded && !!entry.blob,
  });

  return (
    <div style={{ borderBottom: `1px solid ${token.colorBorderSecondary}`, padding: '8px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            color: token.colorTextTertiary,
            fontFamily: 'Geist Mono, monospace',
            fontSize: 12,
            width: 14,
          }}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <Typography.Text
          type="secondary"
          style={{
            fontFamily: 'Geist Mono, monospace',
            fontSize: 12,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatTimestamp(entry.ts)}
        </Typography.Text>
        <Tag color={SOURCE_COLOR[entry.source]} style={{ marginInlineEnd: 0 }}>
          {SOURCE_LABEL[entry.source]}
        </Tag>
        <Typography.Text style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12.5 }}>
          {entry.key}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          [{entry.actions.join(',')}]
        </Typography.Text>
        <Typography.Text
          type="secondary"
          style={{
            fontFamily: 'Geist Mono, monospace',
            fontSize: 11,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {entry.sizeBefore}→{entry.sizeAfter}B
        </Typography.Text>
        {entry.hint !== undefined ? (
          <Tag color="cyan" style={{ marginInlineEnd: 0 }}>
            importance {entry.hint.toFixed(2)}
          </Tag>
        ) : null}
        {entry.sessionKey ? (
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            · {entry.sessionKey}
          </Typography.Text>
        ) : null}
        <span style={{ flex: 1 }} />
        {slug ? (
          <Button
            size="small"
            onClick={() => onRestore(slug)}
            loading={restorePending}
            title={`Restore "${slug}" to its live file`}
          >
            Restore
          </Button>
        ) : null}
      </div>

      {expanded ? (
        <div style={{ marginTop: 8, marginLeft: 22 }}>
          <DiffBlock diff={entry.diff} token={token} />
          {entry.blob ? (
            <div style={{ marginTop: 8 }}>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                Full before-state (diff was truncated):
              </Typography.Text>
              {blobQuery.isLoading ? (
                <div style={{ padding: 8 }}>
                  <Spin size="small" />
                </div>
              ) : blobQuery.data?.content != null ? (
                <DiffBlock diff={blobQuery.data.content} token={token} plain />
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Blob missing — the before-state could not be recovered.
                </Typography.Text>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A scroll-contained diff/content viewer. Add/remove lines colored via theme
 *  tokens; the container owns its own horizontal + vertical overflow so the
 *  page body never scrolls sideways. */
function DiffBlock({
  diff,
  token,
  plain = false,
}: {
  diff: string;
  token: ReturnType<typeof theme.useToken>['token'];
  plain?: boolean;
}) {
  const lines = diff.split('\n');
  return (
    <pre
      style={{
        margin: 0,
        maxHeight: 360,
        overflow: 'auto',
        background: token.colorBgElevated,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadius,
        padding: 12,
        fontFamily: 'Geist Mono, monospace',
        fontSize: 12,
        lineHeight: 1.45,
      }}
    >
      {lines.map((line, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no stable id; order is fixed
          key={i}
          style={{ color: plain ? token.colorText : diffLineColor(line, token), whiteSpace: 'pre' }}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

function diffLineColor(line: string, token: ReturnType<typeof theme.useToken>['token']): string {
  if (line.startsWith('@@')) return token.colorInfo;
  if (line.startsWith('+') && !line.startsWith('+++')) return token.colorSuccess;
  if (line.startsWith('-') && !line.startsWith('---')) return token.colorError;
  return token.colorTextSecondary;
}

// --- Pending sub-view (approve-before-store, L3 §3b) -------------------------

/** One-line preview of a parked candidate's mutation for the queue row. */
function pendingPreview(update: PendingMemory['update']): string {
  if (update.action === 'add' || update.action === 'replace') return update.content.trim();
  if (update.action === 'remove') return `remove lines matching "${update.substringMatch}"`;
  return `delete ${update.key}`;
}

function MemoryPending({ personalityId }: { personalityId: string }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  const pendingQuery = useQuery({
    queryKey: ['memory', 'pending', personalityId],
    queryFn: () => rpc.memory.pendingList({ personalityId }),
    enabled: !!personalityId,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['memory', 'pending', personalityId] });
    // An approved candidate flows into durable memory + its history.
    qc.invalidateQueries({ queryKey: ['memory', 'list'] });
    qc.invalidateQueries({ queryKey: ['memory', 'history', personalityId] });
  };

  const approveMut = useMutation({
    mutationFn: (id: string) => rpc.memory.pendingApprove({ personalityId, id }),
    onSuccess: () => {
      invalidate();
      notification.success({ message: 'Approved — written to memory', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Approve failed', description: (err as Error).message }),
  });

  const rejectMut = useMutation({
    mutationFn: (id: string) => rpc.memory.pendingReject({ personalityId, id }),
    onSuccess: () => {
      invalidate();
      notification.info({ message: 'Rejected — will not be re-proposed', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Reject failed', description: (err as Error).message }),
  });

  const entries = pendingQuery.data?.pending ?? [];
  const busyId =
    (approveMut.isPending && approveMut.variables) || (rejectMut.isPending && rejectMut.variables);

  if (pendingQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 160 }}>
        <Spin />
      </div>
    );
  }
  if (pendingQuery.error) {
    return (
      <Typography.Text type="danger">
        Failed to load pending queue: {(pendingQuery.error as Error).message}
      </Typography.Text>
    );
  }
  if (entries.length === 0) {
    return (
      <Typography.Text type="secondary">
        No pending memory. Captured facts awaiting your approval appear here.
      </Typography.Text>
    );
  }

  return (
    <div className="memory-pending">
      {entries.map((e) => (
        <PendingRow
          key={e.id}
          entry={e}
          busy={busyId === e.id}
          onApprove={() => approveMut.mutate(e.id)}
          onReject={() => rejectMut.mutate(e.id)}
        />
      ))}
    </div>
  );
}

function PendingRow({
  entry,
  busy,
  onApprove,
  onReject,
}: {
  entry: PendingMemory;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { token } = theme.useToken();
  const [expanded, setExpanded] = useState(false);
  const preview = pendingPreview(entry.update);
  const hasBody = entry.update.action === 'add' || entry.update.action === 'replace';

  return (
    <div style={{ borderBottom: `1px solid ${token.colorBorderSecondary}`, padding: '10px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          disabled={!hasBody}
          style={{
            background: 'none',
            border: 'none',
            cursor: hasBody ? 'pointer' : 'default',
            padding: 0,
            color: token.colorTextTertiary,
            fontFamily: 'Geist Mono, monospace',
            fontSize: 12,
            width: 14,
            visibility: hasBody ? 'visible' : 'hidden',
          }}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <Typography.Text
          type="secondary"
          style={{
            fontFamily: 'Geist Mono, monospace',
            fontSize: 12,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatTimestamp(entry.proposedAt)}
        </Typography.Text>
        <Tag color={SOURCE_COLOR[entry.source]} style={{ marginInlineEnd: 0 }}>
          {SOURCE_LABEL[entry.source]}
        </Tag>
        <Typography.Text style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12.5 }}>
          {entry.update.key}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          [{entry.update.action}]
        </Typography.Text>
        {entry.sessionKey ? (
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            · {entry.sessionKey}
          </Typography.Text>
        ) : null}
        <span style={{ flex: 1 }} />
        <Button size="small" onClick={onReject} loading={busy}>
          Reject
        </Button>
        <Button size="small" type="primary" onClick={onApprove} loading={busy}>
          Approve
        </Button>
      </div>

      {!expanded ? (
        <Typography.Paragraph
          type="secondary"
          ellipsis={{ rows: 2 }}
          style={{ margin: '6px 0 0 22px', fontSize: 12.5 }}
        >
          {preview}
        </Typography.Paragraph>
      ) : (
        <div style={{ marginTop: 8, marginLeft: 22 }}>
          <DiffBlock diff={preview} token={token} plain />
        </div>
      )}
    </div>
  );
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return String(ts);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function countMatches(text: string, q: string): number {
  if (!q) return 0;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let count = 0;
  let idx = lower.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = lower.indexOf(needle, idx + needle.length);
  }
  return count;
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return iso;
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}
