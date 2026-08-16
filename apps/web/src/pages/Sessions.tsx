import type { Session } from '@ethosagent/web-contracts';
import type { MenuProps } from 'antd';
import { Button, Dropdown, Input, Popconfirm, Spin, Table } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PersonalityMark } from '../components/ui/PersonalityMark';
import {
  useSessionDelete,
  useSessionExport,
  useSessionFork,
  useSessionRename,
} from '../features/sessions/api/mutations';
import { useSessionList } from '../features/sessions/api/queries';
import { buildWorkspaceChatPath, sessionOpenPath } from '../lib/workspaceRoutes';

// Sessions tab — list, search, paginate, fork, delete. The chat tab uses
// the URL `?session=<id>` deep link as the wire, so all the actions here
// boil down to:
//   • Open   → navigate to /p/:personalityId/chat?session=<id> (P1a)
//   • Fork   → rpc.sessions.fork → navigate to the new id
//   • Delete → rpc.sessions.delete → invalidate this list
//
// FTS5 search is wired in `apps/web-api`; the input below feeds
// `q` directly. Debouncing is local — 400ms after the last keystroke
// before triggering a refetch — so typing fast doesn't fire a refetch
// per character.
//
// Rendered at two addresses:
//   • `/p/:personalityId/sessions` (P2, workspace) — scoped to that agent via
//     `sessions.list({ personalityId })`. Every row shares the same agent, so
//     the Personality column is redundant and doesn't render.
//   • `/library/sessions` (P3, Library twin — "today's global Sessions page,
//     kept intact, with the agent mark per row") — `personalityId` is
//     undefined, `sessions.list({})` is unscoped, and the Personality column
//     renders a small `PersonalityMark` per row.
// The bare `/sessions` URL doesn't reach this component at all (P1a
// permanently redirects it into a workspace).

const SEARCH_DEBOUNCE_MS = 400;

export function Sessions() {
  const navigate = useNavigate();
  const { personalityId } = useParams<{ personalityId?: string }>();

  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');

  // Debounce the input — TanStack Query's queryKey changes drive the
  // refetch, so we only update the key after the user pauses typing.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  const { data, error, isLoading, isFetching, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useSessionList(debouncedSearch, personalityId);

  const flat = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);

  // --- mutations ---

  const deleteMut = useSessionDelete();

  const forkMut = useSessionFork();

  const renameMut = useSessionRename();

  const exportMut = useSessionExport();

  // --- render ---

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <span style={{ color: '#f87171' }}>
          Failed to load sessions: {(error as Error).message}
        </span>
      </div>
    );
  }

  return (
    <div className="sessions-tab">
      <header className="sessions-toolbar">
        <Input.Search
          placeholder="Search sessions (FTS5 over message content)…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          allowClear
          loading={isFetching && !isFetchingNextPage}
          style={{ maxWidth: 480 }}
        />
        <Button
          type="primary"
          onClick={() => navigate(personalityId ? buildWorkspaceChatPath(personalityId) : '/chat')}
          style={{ marginLeft: 8 }}
        >
          New Session
        </Button>
        <span className="sessions-count">
          {flat.length} {flat.length === 1 ? 'session' : 'sessions'}
          {hasNextPage ? '+' : ''}
        </span>
      </header>

      {isLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
          <Spin />
        </div>
      ) : (
        <>
          <Table<Session>
            rowKey="id"
            dataSource={flat}
            pagination={false}
            size="small"
            locale={{
              emptyText: debouncedSearch
                ? `No sessions match "${debouncedSearch}".`
                : 'No sessions yet. Start a chat to create one.',
            }}
            onRow={(record) => ({
              onClick: (e) => {
                // Don't navigate when the click is on the action menu trigger.
                const target = e.target as HTMLElement;
                if (target.closest('.sessions-row-actions')) return;
                navigate(sessionOpenPath(record.id, record.personalityId));
              },
              style: { cursor: 'pointer' },
            })}
            columns={[
              {
                title: 'Name',
                key: 'name',
                ellipsis: true,
                render: (_v: unknown, row: Session) => {
                  if (editingId === row.id) {
                    return (
                      <Input
                        size="small"
                        value={editingValue}
                        autoFocus
                        onChange={(e) => setEditingValue(e.target.value)}
                        onPressEnter={() => {
                          renameMut.mutate({ id: row.id, title: editingValue.trim() || null });
                          setEditingId(null);
                        }}
                        onBlur={() => {
                          renameMut.mutate({ id: row.id, title: editingValue.trim() || null });
                          setEditingId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        style={{ maxWidth: 220 }}
                      />
                    );
                  }
                  const label = row.title ?? `${row.id.slice(0, 8)}…`;
                  const startEdit = () => {
                    setEditingId(row.id);
                    setEditingValue(row.title ?? '');
                  };
                  return (
                    <span className="sessions-name-cell">
                      <button
                        type="button"
                        className="sessions-name"
                        title={row.title ?? undefined}
                        onDoubleClick={startEdit}
                        onKeyDown={(e) => {
                          if (e.key === 'F2') startEdit();
                        }}
                      >
                        {label}
                      </button>
                      <button
                        type="button"
                        className="sessions-name-edit"
                        aria-label="Rename session"
                        title="Rename"
                        onClick={(e) => {
                          e.stopPropagation();
                          startEdit();
                        }}
                      >
                        <PencilIcon />
                      </button>
                    </span>
                  );
                },
              },
              {
                title: 'ID',
                dataIndex: 'id',
                width: 120,
                render: (v: string) => <span className="sessions-mono">{v.slice(0, 8)}…</span>,
              },
              // Library twin only (`/library/sessions`, no `:personalityId`
              // — P3): every row shares the same agent inside a workspace,
              // so the column would be pure repetition there and doesn't
              // render.
              ...(personalityId
                ? []
                : [
                    {
                      title: 'Personality',
                      dataIndex: 'personalityId',
                      width: 140,
                      render: (v: string | null) =>
                        v ? (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <PersonalityMark personalityId={v} size={16} />
                            <span className="sessions-mono" style={{ fontSize: 12 }}>
                              {v}
                            </span>
                          </span>
                        ) : (
                          '—'
                        ),
                    },
                  ]),
              {
                title: 'Model',
                dataIndex: 'model',
                ellipsis: true,
                render: (v: string) => <span className="sessions-mono">{v}</span>,
              },
              {
                title: 'Tokens',
                width: 140,
                render: (_v, row) => (
                  <span className="sessions-mono sessions-num">
                    {formatTokens(row.usage.inputTokens + row.usage.outputTokens)}
                  </span>
                ),
              },
              {
                title: 'Cost',
                width: 90,
                render: (_v, row) => (
                  <span className="sessions-mono sessions-num">
                    {formatCost(row.usage.estimatedCostUsd)}
                  </span>
                ),
              },
              {
                title: 'Updated',
                dataIndex: 'updatedAt',
                width: 180,
                render: (v: string) => <span className="sessions-mono">{formatRelative(v)}</span>,
              },
              {
                title: '',
                width: 56,
                align: 'right' as const,
                render: (_v, row) => (
                  <RowActions
                    id={row.id}
                    onOpen={() => navigate(sessionOpenPath(row.id, row.personalityId))}
                    onRename={() => {
                      setEditingId(row.id);
                      setEditingValue(row.title ?? '');
                    }}
                    onFork={() =>
                      forkMut.mutate(row.id, {
                        onSuccess: (result) => navigate(`/chat?session=${result.session.id}`),
                      })
                    }
                    onExport={() => exportMut.mutate(row.id)}
                    onDelete={() => deleteMut.mutate(row.id)}
                    deleting={deleteMut.isPending && deleteMut.variables === row.id}
                  />
                ),
              },
            ]}
          />

          {hasNextPage ? (
            <div className="sessions-loadmore">
              <Button
                onClick={() => fetchNextPage()}
                loading={isFetchingNextPage}
                disabled={isFetchingNextPage}
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

interface RowActionsProps {
  id: string;
  onOpen: () => void;
  onRename: () => void;
  onFork: () => void;
  onExport: () => void;
  onDelete: () => void;
  deleting: boolean;
}

function RowActions({
  id,
  onOpen,
  onRename,
  onFork,
  onExport,
  onDelete,
  deleting,
}: RowActionsProps) {
  const items: MenuProps['items'] = [
    { key: 'open', label: 'Open' },
    { key: 'rename', label: 'Rename' },
    { key: 'fork', label: 'Fork' },
    { key: 'export', label: 'Export as Markdown' },
    {
      key: 'delete',
      label: (
        <Popconfirm
          title="Delete this session?"
          description="The conversation history is permanently removed."
          okText="Delete"
          okButtonProps={{ danger: true, loading: deleting }}
          cancelText="Cancel"
          onConfirm={(e) => {
            e?.stopPropagation();
            onDelete();
          }}
        >
          <span style={{ color: '#f87171' }}>Delete</span>
        </Popconfirm>
      ),
    },
  ];

  return (
    <div
      role="toolbar"
      aria-label={`Actions for ${id}`}
      className="sessions-row-actions"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Dropdown
        menu={{
          items,
          onClick: ({ key, domEvent }) => {
            domEvent.stopPropagation();
            if (key === 'open') onOpen();
            else if (key === 'rename') onRename();
            else if (key === 'fork') onFork();
            else if (key === 'export') onExport();
            // delete handled by the Popconfirm inside the menu item
          },
        }}
        trigger={['click']}
        placement="bottomRight"
      >
        <button type="button" className="sessions-row-trigger" aria-label="Row actions">
          <DotsIcon />
        </button>
      </Dropdown>
    </div>
  );
}

function DotsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="7" r="1.3" />
      <circle cx="7" cy="7" r="1.3" />
      <circle cx="11" cy="7" r="1.3" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M10 1.5l2.5 2.5L4.5 12H2v-2.5L10 1.5z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatCost(usd: number): string {
  if (usd === 0) return '—';
  if (usd < 0.01) return `<$0.01`;
  return `$${usd.toFixed(2)}`;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
