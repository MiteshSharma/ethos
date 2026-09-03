import type { McpServerInfo } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Empty,
  Popconfirm,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AddMcpModal } from '../components/mcp/AddMcpModal';
import { McpCatalogSection } from '../components/mcp/McpCatalogSection';
import { McpSectionLabel } from '../components/mcp/McpSectionLabel';
import { McpServerActions } from '../components/mcp/McpServerActions';
import { PersonalityMark } from '../components/ui/PersonalityMark';
import { mcpKeys } from '../features/mcp/api/keys';
import { useMcpPersonalityServers } from '../features/mcp/api/queries';
import { personalityKeys } from '../features/personalities/api/keys';
import { useCreateFlag } from '../hooks/useCreateFlag';
import { splitByAttachment, usedByPersonalityIds } from '../lib/attachmentLists';
import { rpc } from '../rpc';

// P2 (plan/phases/personality-first-ui.md): `/mcp` (Library, unscoped — the
// full installed-server matrix, unchanged) and `/p/:personalityId/mcp`
// (workspace — `mcp.personalityServers({ personalityId })`, only the
// servers this agent has attached, with THIS agent's own auth status) are
// two different components sharing one route name, same split as Skills.
export function Mcp() {
  const { personalityId } = useParams<{ personalityId?: string }>();
  return personalityId ? <WorkspaceMcpPanel personalityId={personalityId} /> : <LibraryMcpPage />;
}

function LibraryMcpPage() {
  const [addMcpOpen, setAddMcpOpen] = useState(false);

  // P5 — StageHeader's "+ New MCP Server" action navigates here with
  // `?create=1`; this opens the same AddMcpModal the page's own button does.
  const shouldCreate = useCreateFlag();
  useEffect(() => {
    if (shouldCreate) setAddMcpOpen(true);
  }, [shouldCreate]);

  const {
    data: pluginsData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['plugins', 'list'],
    queryFn: () => rpc.plugins.list(),
  });

  const mcpServers = pluginsData?.mcpServers ?? [];
  const registeredNames = useMemo(() => new Set(mcpServers.map((s) => s.name)), [mcpServers]);

  if (error) {
    return (
      <Typography.Text type="danger">
        Failed to load MCP servers: {(error as Error).message}
      </Typography.Text>
    );
  }

  return (
    <div className="plugins-tab">
      <header className="page-header-row">
        <h1 className="page-h1">All servers</h1>
        <span className="page-subtitle">
          {mcpServers.length} {mcpServers.length === 1 ? 'server' : 'servers'}
        </span>
        <div style={{ flex: 1 }} />
        <button type="button" className="page-action-btn" onClick={() => setAddMcpOpen(true)}>
          + New MCP Server
        </button>
      </header>
      <McpCatalogSection registeredNames={registeredNames} />
      <McpTable servers={mcpServers} loading={isLoading} />
      <AddMcpModal open={addMcpOpen} onClose={() => setAddMcpOpen(false)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace panel — P3: two lists, attached and installed-but-not-attached,
// each row with a toggle.
//
// Attach goes through `mcp.attachPersonalities({ serverName, personalityIds:
// [personalityId] })` — verified against `McpInstallFlow.attachToPersonalities`
// (extensions/tools-mcp/src/install-flow.ts): it's ADD-ONLY and idempotent
// per id (a personality already in the list is a no-op), and only ever
// touches ids present in the array — passing just this one workspace's id is
// enough, no need to read anyone else's state first.
//
// Detach can NOT go through that same RPC — read the source and it becomes
// clear `attachToPersonalities` has no removal branch at all: dropping an id
// from `personalityIds` does not touch that personality, it's simply not
// iterated. (The plan doc's "read current ids, add/remove one, send the
// whole array back" description doesn't hold; verified live against
// swing-trader — the detach silently no-op'd on the backend, not just the
// UI.) Detach instead goes through `personalities.update({ id, mcp_servers
// })`, the same RPC `PersonalityDetail.tsx`'s own MCP section already uses
// for removal (`removeMut`), scoped to this one personality's own list.
// ---------------------------------------------------------------------------

function WorkspaceMcpPanel({ personalityId }: { personalityId: string }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  const attachedQuery = useMcpPersonalityServers(personalityId);
  const attached = attachedQuery.data?.servers ?? [];
  const attachedNames = useMemo(() => new Set(attached.map((s) => s.name)), [attached]);

  const globalServersQuery = useQuery({
    queryKey: ['plugins', 'list'],
    queryFn: () => rpc.plugins.list(),
  });

  const { notAttached } = useMemo(
    () =>
      splitByAttachment(globalServersQuery.data?.mcpServers ?? [], attachedNames, (s) => s.name),
    [globalServersQuery.data, attachedNames],
  );

  // Every globally registered server — the catalog section (below) filters
  // out any preset that already matches one of these, whether or not it's
  // attached to this personality (plan §2.3).
  const registeredNames = useMemo(
    () => new Set((globalServersQuery.data?.mcpServers ?? []).map((s) => s.name)),
    [globalServersQuery.data],
  );

  // Shared query keys, not a dedicated round trip (P3's "Done when" bar):
  // `personalityKeys.list()` feeds the ScopeNav fraction, the Library "Used
  // by" cell, and the Plugins matrix; `mcpKeys.personalityServers(id)` is
  // this panel's own attached list.
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: personalityKeys.list() });
    qc.invalidateQueries({ queryKey: mcpKeys.personalityServers(personalityId) });
  };

  const attachMut = useMutation({
    mutationFn: (serverName: string) =>
      rpc.mcp.attachPersonalities({ serverName, personalityIds: [personalityId] }),
    onSuccess: (result) => {
      invalidate();
      if (result.failed.length > 0) {
        notification.error({
          message: 'Attach failed',
          description: result.failed.map((f) => f.error).join('; '),
        });
      }
    },
    onError: (err) =>
      notification.error({ message: 'Attach failed', description: (err as Error).message }),
  });

  const detachMut = useMutation({
    mutationFn: (serverName: string) =>
      rpc.personalities.update({
        id: personalityId,
        mcp_servers: attached.filter((s) => s.name !== serverName).map((s) => s.name),
      }),
    onSuccess: () => invalidate(),
    onError: (err) =>
      notification.error({ message: 'Detach failed', description: (err as Error).message }),
  });

  const isLoading = attachedQuery.isLoading || globalServersQuery.isLoading;

  if (attachedQuery.error) {
    return (
      <Typography.Text type="danger">
        Failed to load MCP servers: {(attachedQuery.error as Error).message}
      </Typography.Text>
    );
  }

  return (
    <div className="plugins-tab">
      <header className="page-header-row">
        <h1 className="page-h1">MCP Servers</h1>
        <span className="page-subtitle">
          {attached.length} {attached.length === 1 ? 'server' : 'servers'}
        </span>
      </header>
      {isLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
          <Spin />
        </div>
      ) : (
        <>
          <McpSectionLabel>Attached ({attached.length})</McpSectionLabel>
          {attached.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No MCP servers attached to this agent. Attach one from the library below."
            />
          ) : (
            <McpToggleTable
              servers={attached}
              checked
              pending={detachMut.isPending ? detachMut.variables : undefined}
              onToggle={(serverName) => detachMut.mutate(serverName)}
            />
          )}

          <McpSectionLabel>Installed, not attached ({notAttached.length})</McpSectionLabel>
          {notAttached.length === 0 ? (
            <Typography.Text type="secondary">
              Every configured server is already attached to this agent.
            </Typography.Text>
          ) : (
            <McpToggleTable
              servers={notAttached}
              checked={false}
              pending={attachMut.isPending ? attachMut.variables : undefined}
              onToggle={(serverName) => attachMut.mutate(serverName)}
            />
          )}

          <McpCatalogSection registeredNames={registeredNames} />
        </>
      )}
    </div>
  );
}

// Minimal shape shared by both row sources: `mcp.personalityServers` (the
// attached list — narrower, no `command`/`url`/`created_via`/etc.) and
// `plugins.list().mcpServers` / `McpServerInfo` (the global not-attached
// list). Structural typing lets one table render both.
interface McpToggleRow {
  name: string;
  transport?: string;
  auth_status?: string | null;
}

function McpToggleTable<T extends McpToggleRow>({
  servers,
  checked,
  pending,
  onToggle,
}: {
  servers: T[];
  checked: boolean;
  pending: string | undefined;
  onToggle: (serverName: string) => void;
}) {
  return (
    <Table<T>
      rowKey="name"
      dataSource={servers}
      pagination={false}
      size="small"
      columns={[
        {
          title: 'Name',
          dataIndex: 'name',
          key: 'name',
          render: (name: string) => <strong>{name}</strong>,
        },
        {
          title: 'Transport',
          dataIndex: 'transport',
          key: 'transport',
          width: 150,
          render: (t: string | undefined) => (t ? <Tag bordered={false}>{t}</Tag> : '—'),
        },
        {
          title: 'Auth',
          dataIndex: 'auth_status',
          key: 'auth',
          width: 120,
          render: (s: string | null | undefined) => {
            if (s === 'authorized')
              return (
                <Tag color="green" bordered={false}>
                  authorized
                </Tag>
              );
            if (s === 'expired')
              return (
                <Tag color="orange" bordered={false}>
                  expired
                </Tag>
              );
            if (s === 'missing')
              return (
                <Tag color="red" bordered={false}>
                  missing
                </Tag>
              );
            return null;
          },
        },
        {
          title: '',
          key: 'toggle',
          width: 90,
          align: 'right' as const,
          render: (_: unknown, server: T) => (
            <Switch
              size="small"
              checked={checked}
              loading={pending === server.name}
              onChange={() => onToggle(server.name)}
              aria-label={`${checked ? 'Detach' : 'Attach'} ${server.name}`}
            />
          ),
        },
      ]}
    />
  );
}

function McpTable({ servers, loading }: { servers: McpServerInfo[]; loading?: boolean }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  const deleteMut = useMutation({
    mutationFn: (name: string) => rpc.mcp.delete({ name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plugins'] });
      qc.invalidateQueries({ queryKey: ['mcp', 'list'] });
    },
    onError: (err) => {
      notification.error({
        message: 'Delete failed',
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  if (loading) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'rgba(255,255,255,0.45)' }}>
        Loading...
      </div>
    );
  }

  if (servers.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span>
            No MCP servers configured. Click <strong>Add MCP</strong> above, or run{' '}
            <Typography.Text code>ethos mcp add</Typography.Text> from the CLI.
          </span>
        }
      />
    );
  }

  return (
    <Table<McpServerInfo>
      rowKey="name"
      dataSource={servers}
      pagination={false}
      size="small"
      columns={[
        {
          title: 'Name',
          dataIndex: 'name',
          key: 'name',
          render: (name: string) => <strong>{name}</strong>,
        },
        {
          title: 'Transport',
          dataIndex: 'transport',
          key: 'transport',
          width: 150,
          render: (t: string) => (
            <span>
              <Tag bordered={false}>{t}</Tag>
              {t === 'sse' ? (
                <Tag color="warning" bordered={false} style={{ fontSize: 11, marginLeft: 4 }}>
                  deprecated
                </Tag>
              ) : null}
            </span>
          ),
        },
        {
          title: 'Endpoint',
          key: 'endpoint',
          render: (_, server) =>
            server.transport === 'stdio' ? (
              server.command ? (
                <Typography.Text code style={{ fontSize: 11 }}>
                  {server.command}
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary">missing command</Typography.Text>
              )
            ) : server.url ? (
              <Typography.Text code style={{ fontSize: 11 }}>
                {server.url}
              </Typography.Text>
            ) : (
              <Typography.Text type="secondary">missing url</Typography.Text>
            ),
        },
        {
          title: 'Auth',
          key: 'auth',
          width: 100,
          render: (_, server) => {
            const s = server.auth_status;
            if (!s || s === 'none') return <Tag bordered={false}>none</Tag>;
            if (s === 'authorized')
              return (
                <Tag color="green" bordered={false}>
                  authorized
                </Tag>
              );
            if (s === 'expired')
              return (
                <Tag color="orange" bordered={false}>
                  expired
                </Tag>
              );
            if (s === 'missing')
              return (
                <Tag color="red" bordered={false}>
                  missing
                </Tag>
              );
            if (s === 'pending')
              return (
                <Tag color="blue" bordered={false}>
                  pending
                </Tag>
              );
            return null;
          },
        },
        {
          title: 'Used by',
          key: 'attached',
          render: (_: unknown, server: McpServerInfo) => (
            <AttachedPersonalitiesCell serverName={server.name} />
          ),
        },
        {
          title: '',
          key: 'actions',
          width: 260,
          render: (_, server) => (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <McpServerActions
                serverName={server.name}
                transport={server.transport}
                authStatus={server.auth_status}
              />
              <Popconfirm
                title="Remove this server?"
                description="This removes the server definition and any stored tokens. Personalities that reference it will lose the connection."
                okText="Remove"
                okButtonProps={{ danger: true }}
                onConfirm={() => deleteMut.mutate(server.name)}
              >
                <Button
                  size="small"
                  danger
                  loading={
                    deleteMut.isPending &&
                    (deleteMut.variables as string | undefined) === server.name
                  }
                >
                  Remove
                </Button>
              </Popconfirm>
            </div>
          ),
        },
      ]}
    />
  );
}

// P3 "Used by" — reads straight off `personalities.list()`'s own
// `mcp_servers[]`, the same query key (`personalityKeys.list()`) the
// workspace attach/detach toggle above invalidates, so one toggle refreshes
// this cell too.
function AttachedPersonalitiesCell({ serverName }: { serverName: string }) {
  const { data } = useQuery({
    queryKey: personalityKeys.list(),
    queryFn: () => rpc.personalities.list({}),
  });
  const personalities = data?.items ?? [];
  const attachments = personalities.map((p) => ({
    personalityId: p.id,
    itemIds: p.mcp_servers ?? [],
  }));
  const ids = usedByPersonalityIds(serverName, attachments);
  if (ids.length === 0) {
    return <Typography.Text type="secondary">none</Typography.Text>;
  }
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {ids.map((id) => (
        <Tooltip key={id} title={personalities.find((p) => p.id === id)?.name ?? id}>
          <span style={{ display: 'inline-flex' }}>
            <PersonalityMark
              personalityId={id}
              size={16}
              avatarUrl={personalities.find((p) => p.id === id)?.display?.avatar_url}
            />
          </span>
        </Tooltip>
      ))}
    </div>
  );
}
