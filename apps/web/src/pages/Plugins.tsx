import type { McpServerInfo, PluginInfo } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Checkbox,
  Collapse,
  Empty,
  Skeleton,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useState } from 'react';
import { rpc } from '../rpc';

// Plugins page — global matrix of plugins × personalities.
//
// Two surfaces:
//   1. Matrix tab: Antd Table, rows = plugins, cols = personalities.
//      Below 900px: pivots to per-plugin Collapse accordion.
//   2. MCP Servers tab: read-only list of configured MCP servers.
//
// Attachment toggles call personalities.update({ plugins: [...] })
// optimistically per-personality per-plugin. Rollback on error.

export function Plugins() {
  const { data: pluginsData, isLoading: pluginsLoading, error: pluginsError } = useQuery({
    queryKey: ['plugins', 'list'],
    queryFn: () => rpc.plugins.list(),
  });

  const { data: personalitiesData, isLoading: persLoading } = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list(),
  });

  const isLoading = pluginsLoading || persLoading;

  if (pluginsError) {
    return (
      <Typography.Text type="danger">
        Failed to load plugins: {(pluginsError as Error).message}
      </Typography.Text>
    );
  }

  const plugins = pluginsData?.plugins ?? [];
  const mcpServers = pluginsData?.mcpServers ?? [];
  const personalities = personalitiesData?.personalities ?? [];

  return (
    <div className="plugins-tab">
      <Tabs
        defaultActiveKey="matrix"
        items={[
          {
            key: 'matrix',
            label: `Plugins (${plugins.length})`,
            children: (
              <PluginsMatrix plugins={plugins} personalities={personalities} loading={isLoading} />
            ),
          },
          {
            key: 'mcp',
            label: `MCP Servers (${mcpServers.length})`,
            children: <McpTable servers={mcpServers} />,
          },
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Matrix — plugins × personalities. Responsive: table above 900px,
// per-plugin accordion below 900px.
// ---------------------------------------------------------------------------

function PluginsMatrix({
  plugins,
  personalities,
  loading,
}: {
  plugins: PluginInfo[];
  personalities: import('@ethosagent/web-contracts').Personality[];
  loading: boolean;
}) {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 900);

  // Detect viewport width changes.
  if (typeof window !== 'undefined') {
    const mq = window.matchMedia('(max-width: 899px)');
    mq.onchange = (e) => setNarrow(e.matches);
  }

  if (loading) {
    return <Skeleton active paragraph={{ rows: 5 }} />;
  }

  if (plugins.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span>
            No plugins installed.{' '}
            <Typography.Text code>ethos plugin install &lt;path&gt;</Typography.Text> drops one
            into ~/.ethos/plugins/.
          </span>
        }
      />
    );
  }

  // Unattached: plugins with zero personality attachments anywhere.
  const unattached = plugins.filter((p) =>
    personalities.every((pers) => !(pers.plugins ?? []).includes(p.id)),
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {unattached.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`${unattached.length} ${unattached.length === 1 ? 'plugin is' : 'plugins are'} installed but not attached to any personality — they're inert until attached.`}
          closable
        />
      ) : null}
      {narrow ? (
        <PluginsAccordion plugins={plugins} personalities={personalities} />
      ) : (
        <PluginsTable plugins={plugins} personalities={personalities} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full matrix table (≥900px)
// ---------------------------------------------------------------------------

function PluginsTable({
  plugins,
  personalities,
}: {
  plugins: PluginInfo[];
  personalities: import('@ethosagent/web-contracts').Personality[];
}) {
  const personalityCols = personalities.map((pers) => ({
    title: <span style={{ fontSize: 12 }}>{pers.name}</span>,
    key: pers.id,
    width: 120,
    align: 'center' as const,
    render: (_: unknown, plugin: PluginInfo) => (
      <AttachCell plugin={plugin} personality={pers} />
    ),
  }));

  return (
    <div role="grid" aria-label="Plugin attachment matrix">
      <Table<PluginInfo>
        rowKey="id"
        dataSource={plugins}
        pagination={false}
        size="small"
        columns={[
          {
            title: 'Plugin',
            key: 'plugin',
            render: (_, p) => (
              <div>
                <div style={{ fontWeight: 500 }}>{p.name}</div>
                <Typography.Text
                  style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}
                  type="secondary"
                >
                  {p.id}
                </Typography.Text>
              </div>
            ),
          },
          ...personalityCols,
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-plugin accordion (< 900px)
// ---------------------------------------------------------------------------

function PluginsAccordion({
  plugins,
  personalities,
}: {
  plugins: PluginInfo[];
  personalities: import('@ethosagent/web-contracts').Personality[];
}) {
  return (
    <Collapse
      accordion={false}
      items={plugins.map((plugin) => ({
        key: plugin.id,
        label: (
          <span>
            <span style={{ fontWeight: 500 }}>{plugin.name}</span>{' '}
            <Typography.Text
              style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}
              type="secondary"
            >
              {plugin.id}
            </Typography.Text>
          </span>
        ),
        children: (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {personalities.map((pers) => (
              <div
                key={pers.id}
                style={{ display: 'flex', alignItems: 'center', gap: 10 }}
              >
                <AttachCell plugin={plugin} personality={pers} />
                <span>{pers.name}</span>
              </div>
            ))}
          </div>
        ),
      }))}
    />
  );
}

// ---------------------------------------------------------------------------
// Single attach cell — optimistic Switch/Checkbox toggle
// ---------------------------------------------------------------------------

function AttachCell({
  plugin,
  personality,
}: {
  plugin: PluginInfo;
  personality: import('@ethosagent/web-contracts').Personality;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const current = personality.plugins ?? [];
  const isOn = current.includes(plugin.id);

  const mut = useMutation({
    mutationFn: (next: string[]) =>
      rpc.personalities.update({ id: personality.id, plugins: next }),
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: ['personalities', 'list'] });
      const prev = qc.getQueryData<{ personalities: import('@ethosagent/web-contracts').Personality[] }>([
        'personalities',
        'list',
      ]);
      qc.setQueryData<{ personalities: import('@ethosagent/web-contracts').Personality[]; defaultId: string }>(
        ['personalities', 'list'],
        (old) => {
          if (!old) return old;
          return {
            ...old,
            personalities: old.personalities.map((p) =>
              p.id === personality.id ? { ...p, plugins: next } : p,
            ),
          };
        },
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['personalities', 'list'], ctx.prev);
      notification.error({
        message: 'Attach failed',
        description: `Could not update ${personality.name}`,
      });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
    },
  });

  function toggle(on: boolean) {
    const next = on
      ? [...current, plugin.id]
      : current.filter((id) => id !== plugin.id);
    mut.mutate(next);
  }

  return (
    <Checkbox
      checked={isOn}
      disabled={mut.isPending}
      onChange={(e) => toggle(e.target.checked)}
      aria-label={`Attach ${plugin.name} to ${personality.name}`}
    />
  );
}

// ---------------------------------------------------------------------------
// MCP Servers tab — read-only
// ---------------------------------------------------------------------------

function McpTable({ servers }: { servers: McpServerInfo[] }) {
  if (servers.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span>
            No MCP servers configured. Edit{' '}
            <Typography.Text code>~/.ethos/mcp.json</Typography.Text> or run{' '}
            <Typography.Text code>ethos plugin add-mcp</Typography.Text>.
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
          width: 120,
          render: (t: string) => <Tag bordered={false}>{t}</Tag>,
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
          title: 'Attached to',
          key: 'attached',
          render: (_: unknown, server: McpServerInfo) => (
            <AttachedPersonalitiesCell serverName={server.name} />
          ),
        },
      ]}
    />
  );
}

function AttachedPersonalitiesCell({ serverName }: { serverName: string }) {
  const { data } = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list(),
  });
  const attached = (data?.personalities ?? []).filter((p) =>
    (p.mcp_servers ?? []).includes(serverName),
  );
  if (attached.length === 0) {
    return <Typography.Text type="secondary">none</Typography.Text>;
  }
  return (
    <Tooltip title={attached.map((p) => p.id).join(', ')}>
      <span>
        {attached
          .slice(0, 3)
          .map((p) => p.name)
          .join(', ')}
        {attached.length > 3 ? ` +${attached.length - 3}` : ''}
      </span>
    </Tooltip>
  );
}
