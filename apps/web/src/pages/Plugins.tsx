import type { McpServerInfo, PluginInfo } from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { Empty, Spin, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { rpc } from '../rpc';

// Plugins tab — v1.
//
// Read-only inventory of what's installed locally:
//   • Plugins (~/.ethos/plugins/<id>/) discovered via the same
//     manifest gate the loader uses (`ethos.type === 'plugin'`).
//   • MCP servers configured in ~/.ethos/mcp.json.
//
// Install / remove / declared-tools-view are CLI-only for v1; the
// page surfaces what's there so users can verify their agent's
// contract surface without reading config files by hand.

export function Plugins() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['plugins', 'list'],
    queryFn: () => rpc.plugins.list(),
  });

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
        Failed to load plugins: {(error as Error).message}
      </Typography.Text>
    );
  }

  const plugins = data?.plugins ?? [];
  const mcpServers = data?.mcpServers ?? [];

  return (
    <div className="plugins-tab">
      <Tabs
        defaultActiveKey="plugins"
        items={[
          {
            key: 'plugins',
            label: `Plugins (${plugins.length})`,
            children: <PluginsTable plugins={plugins} />,
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

function PluginsTable({ plugins }: { plugins: PluginInfo[] }) {
  if (plugins.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span>
            No plugins installed.{' '}
            <Typography.Text code>ethos plugin install &lt;path&gt;</Typography.Text> drops one into
            ~/.ethos/plugins/.
          </span>
        }
      />
    );
  }
  return (
    <Table<PluginInfo>
      rowKey="id"
      dataSource={plugins}
      pagination={false}
      size="small"
      columns={[
        {
          title: 'Name',
          dataIndex: 'name',
          key: 'name',
          render: (name: string, plugin) => (
            <div>
              <div style={{ fontWeight: 500 }}>{name}</div>
              <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11 }}>
                {plugin.id} · v{plugin.version}
              </div>
            </div>
          ),
        },
        {
          title: 'Description',
          dataIndex: 'description',
          key: 'description',
          render: (d: string | null) =>
            d ? d : <Typography.Text type="secondary">—</Typography.Text>,
        },
        {
          title: 'Source',
          dataIndex: 'source',
          key: 'source',
          width: 100,
          render: (s: PluginInfo['source']) => <Tag bordered={false}>{s}</Tag>,
        },
        {
          title: 'Contract',
          dataIndex: 'pluginContractMajor',
          key: 'pluginContractMajor',
          width: 100,
          render: (v: number | null) =>
            v === null ? <Typography.Text type="secondary">—</Typography.Text> : `v${v}`,
        },
        {
          title: 'Path',
          dataIndex: 'path',
          key: 'path',
          render: (p: string) => (
            <Tooltip title={p}>
              <Typography.Text code style={{ fontSize: 11 }}>
                {p.replace(/^.+\/(?=plugins\/)/, '…/')}
              </Typography.Text>
            </Tooltip>
          ),
        },
      ]}
    />
  );
}

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
      ]}
    />
  );
}
