import type { Session } from '@ethosagent/web-contracts';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { MenuProps } from 'antd';
import { App as AntApp, Button, Dropdown, Input, Popconfirm, Spin, Table } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { rpc } from '../rpc';

// Sessions tab — list, search, paginate, fork, delete. The chat tab uses
// the URL `?session=<id>` deep link as the wire, so all the actions here
// boil down to:
//   • Open   → navigate to /chat?session=<id>
//   • Fork   → rpc.sessions.fork → navigate to the new id
//   • Delete → rpc.sessions.delete → invalidate this list
//
// FTS5 search is wired in `extensions/web-api`; the input below feeds
// `q` directly. Debouncing is local — 400ms after the last keystroke
// before triggering a refetch — so typing fast doesn't fire a refetch
// per character.

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 400;

export function Sessions() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();

  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Debounce the input — TanStack Query's queryKey changes drive the
  // refetch, so we only update the key after the user pauses typing.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  const queryKey = useMemo(
    () => ['sessions', 'list', { q: debouncedSearch }] as const,
    [debouncedSearch],
  );

  const { data, error, isLoading, isFetching, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey,
      queryFn: ({ pageParam }: { pageParam: string | null }) =>
        rpc.sessions.list({
          limit: PAGE_SIZE,
          ...(debouncedSearch ? { q: debouncedSearch } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        }),
      initialPageParam: null as string | null,
      getNextPageParam: (last) => last.nextCursor,
    });

  const flat = useMemo(() => data?.pages.flatMap((p) => p.sessions) ?? [], [data]);

  // --- mutations ---

  const deleteMut = useMutation({
    mutationFn: (id: string) => rpc.sessions.delete({ id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'list'] });
    },
    onError: (err) => {
      notification.error({
        message: 'Could not delete session',
        description: err instanceof Error ? err.message : String(err),
        placement: 'topRight',
      });
    },
  });

  const forkMut = useMutation({
    mutationFn: (id: string) => rpc.sessions.fork({ id }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'list'] });
      navigate(`/chat?session=${result.session.id}`);
    },
    onError: (err) => {
      notification.error({
        message: 'Could not fork session',
        description: err instanceof Error ? err.message : String(err),
        placement: 'topRight',
      });
    },
  });

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
                navigate(`/chat?session=${record.id}`);
              },
              style: { cursor: 'pointer' },
            })}
            columns={[
              {
                title: 'ID',
                dataIndex: 'id',
                width: 120,
                render: (v: string) => <span className="sessions-mono">{v.slice(0, 8)}…</span>,
              },
              {
                title: 'Personality',
                dataIndex: 'personalityId',
                width: 140,
                render: (v: string | null) => v ?? '—',
              },
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
                    onOpen={() => navigate(`/chat?session=${row.id}`)}
                    onFork={() => forkMut.mutate(row.id)}
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
  onFork: () => void;
  onDelete: () => void;
  deleting: boolean;
}

function RowActions({ id, onOpen, onFork, onDelete, deleting }: RowActionsProps) {
  const items: MenuProps['items'] = [
    { key: 'open', label: 'Open' },
    { key: 'fork', label: 'Fork' },
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
      className="sessions-row-actions"
      onClick={(e) => e.stopPropagation()}
      aria-label={`Actions for ${id}`}
    >
      <Dropdown
        menu={{
          items,
          onClick: ({ key, domEvent }) => {
            domEvent.stopPropagation();
            if (key === 'open') onOpen();
            else if (key === 'fork') onFork();
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
