import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { rpc } from '../rpc';

type Channel = {
  id: string;
  platform: string;
  status: string;
  webhookUrl?: string;
};

type Provider = {
  id: string;
  name: string;
  hasKey: boolean;
  healthy?: boolean;
  latencyMs?: number;
};

type McpServer = {
  name: string;
  status: string;
  toolCount?: number;
};

/** `admin.getStatus().executionBackend` — null when no remote target is
 *  configured, which is what a fresh install looks like. */
type ExecutionBackendStatus = { name: string; resolved: boolean; error: string | null } | null;

/**
 * Boot failure for the remote execution backend
 * (plan/phases/remote-execution-routing.md §6). A row, not a Tag in a table:
 * this is not one of many peers, it is a single fact about whether the backend
 * the posture NAMES exists at all.
 *
 * Renders NOTHING when there is no remote target (`null`) or when the backend
 * resolves — a panel that announced "execution ok" on every install would be
 * noise, and this row exists to be seen when it appears. Glyph and word carry
 * the state; the outline colour is the third signal.
 */
export function AdminExecutionRow({ backend }: { backend: ExecutionBackendStatus }) {
  if (!backend || backend.resolved) return null;
  return (
    <div className="admin-execution-row admin-execution-row--error">
      <span aria-hidden="true">✗</span>
      <span>failed</span>
      <span>Execution backend {backend.name} failed to resolve — see logs</span>
    </div>
  );
}

export function Admin() {
  const { notification } = AntApp.useApp();
  const qc = useQueryClient();

  const statusQuery = useQuery({
    queryKey: ['admin', 'status'],
    queryFn: () => rpc.admin.getStatus(),
  });

  const checkMut = useMutation({
    mutationFn: (provider: string) => rpc.admin.checkProvider({ provider }),
    onSuccess: (data) => {
      if (data.ok) {
        notification.success({
          message: `Provider healthy (${data.latencyMs}ms)`,
          placement: 'topRight',
        });
      } else {
        notification.warning({
          message: `Provider check failed (${data.latencyMs}ms)`,
          placement: 'topRight',
        });
      }
      qc.invalidateQueries({ queryKey: ['admin', 'status'] });
    },
  });

  const testSendMut = useMutation({
    mutationFn: (channel: string) => rpc.admin.testSend({ channel }),
    onSuccess: (data) => {
      if (data.ok) {
        notification.success({
          message: 'Test message sent',
          placement: 'topRight',
        });
      } else {
        notification.warning({
          message: 'Test send failed',
          description: data.error,
          placement: 'topRight',
        });
      }
    },
    onError: (err) =>
      notification.error({
        message: 'Test send failed',
        description: (err as Error).message,
      }),
  });

  const removeMcpMut = useMutation({
    mutationFn: (name: string) => rpc.admin.removeMcpServer({ name }),
    onSuccess: () => {
      notification.success({
        message: 'MCP server removed',
        placement: 'topRight',
      });
      qc.invalidateQueries({ queryKey: ['admin', 'status'] });
    },
  });

  const [addMcpOpen, setAddMcpOpen] = useState(false);
  const [addMcpForm] = Form.useForm<{
    name: string;
    url: string;
    authType: 'none' | 'bearer' | 'oauth';
  }>();

  const addMcpMut = useMutation({
    mutationFn: (input: { name: string; url: string; authType: 'none' | 'bearer' | 'oauth' }) =>
      rpc.admin.addMcpServer(input),
    onSuccess: () => {
      notification.success({
        message: 'MCP server added',
        placement: 'topRight',
      });
      setAddMcpOpen(false);
      addMcpForm.resetFields();
      qc.invalidateQueries({ queryKey: ['admin', 'status'] });
    },
    onError: (err) =>
      notification.error({
        message: 'Failed to add MCP server',
        description: (err as Error).message,
      }),
  });

  if (statusQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }

  if (statusQuery.error) {
    return (
      <Typography.Text type="danger">
        Failed to load admin status: {(statusQuery.error as Error).message}
      </Typography.Text>
    );
  }

  const status = statusQuery.data;

  const channelColumns: ColumnsType<Channel> = [
    {
      title: 'Platform',
      dataIndex: 'platform',
      key: 'platform',
    },
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (s: string) => {
        const color = s === 'connected' ? 'green' : s === 'error' ? 'red' : 'default';
        return <Tag color={color}>{s}</Tag>;
      },
    },
    {
      title: 'Webhook URL',
      dataIndex: 'webhookUrl',
      key: 'webhookUrl',
      render: (v?: string) =>
        v ? (
          <Typography.Text copyable style={{ fontSize: 12 }}>
            {v}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: unknown, record: { id: string }) => (
        <Button
          size="small"
          onClick={() => testSendMut.mutate(record.id)}
          loading={testSendMut.isPending}
        >
          Test send
        </Button>
      ),
    },
  ];

  const providerColumns: ColumnsType<Provider> = [
    { title: 'Provider', dataIndex: 'name', key: 'name' },
    {
      title: 'API Key',
      dataIndex: 'hasKey',
      key: 'hasKey',
      render: (v: boolean) =>
        v ? <Tag color="green">Configured</Tag> : <Tag color="default">Missing</Tag>,
    },
    {
      title: 'Health',
      key: 'health',
      render: (_: unknown, record: { healthy?: boolean; latencyMs?: number }) => {
        if (record.healthy === undefined) {
          return <Typography.Text type="secondary">Unknown</Typography.Text>;
        }
        return record.healthy ? (
          <Tag color="green">
            Healthy
            {record.latencyMs != null ? ` (${record.latencyMs}ms)` : ''}
          </Tag>
        ) : (
          <Tag color="red">Unhealthy</Tag>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: unknown, record: { id: string }) => (
        <Button
          size="small"
          onClick={() => checkMut.mutate(record.id)}
          loading={checkMut.isPending}
        >
          Check
        </Button>
      ),
    },
  ];

  const mcpColumns: ColumnsType<McpServer> = [
    { title: 'Name', dataIndex: 'name', key: 'name' },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (s: string) => {
        const color = s === 'connected' ? 'green' : s === 'error' ? 'red' : 'default';
        return <Tag color={color}>{s}</Tag>;
      },
    },
    {
      title: 'Tools',
      dataIndex: 'toolCount',
      key: 'toolCount',
      render: (v?: number) => (v != null ? String(v) : '-'),
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: unknown, record: { name: string }) => (
        <Button
          size="small"
          danger
          onClick={() => removeMcpMut.mutate(record.name)}
          loading={removeMcpMut.isPending}
        >
          Remove
        </Button>
      ),
    },
  ];

  const tabItems = [
    {
      key: 'channels',
      label: 'Channels',
      children: (
        <Table
          columns={channelColumns}
          dataSource={status?.channels ?? []}
          rowKey="id"
          size="small"
          pagination={false}
          locale={{ emptyText: 'No channels configured.' }}
        />
      ),
    },
    {
      key: 'keys',
      label: 'API Keys',
      children: (
        <Table
          columns={providerColumns}
          dataSource={status?.providers ?? []}
          rowKey="id"
          size="small"
          pagination={false}
          locale={{ emptyText: 'No providers configured.' }}
        />
      ),
    },
    {
      key: 'mcp',
      label: 'MCP Servers',
      children: (
        <>
          <div style={{ marginBottom: 12 }}>
            <Button type="primary" size="small" onClick={() => setAddMcpOpen(true)}>
              Add MCP Server
            </Button>
          </div>
          <Table
            columns={mcpColumns}
            dataSource={status?.mcpServers ?? []}
            rowKey="name"
            size="small"
            pagination={false}
            locale={{ emptyText: 'No MCP servers configured.' }}
          />
        </>
      ),
    },
  ];

  return (
    <div className="admin-tab">
      <header className="page-header-row">
        <h1 className="page-h1">Admin</h1>
        <span className="page-subtitle">Channels, keys, and MCP servers</span>
      </header>
      <AdminExecutionRow backend={status?.executionBackend ?? null} />
      <Tabs items={tabItems} />

      <Modal
        title="Add MCP Server"
        open={addMcpOpen}
        onCancel={() => {
          setAddMcpOpen(false);
          addMcpForm.resetFields();
        }}
        onOk={() => addMcpForm.submit()}
        confirmLoading={addMcpMut.isPending}
        okText="Add"
        destroyOnClose
      >
        <Form form={addMcpForm} layout="vertical" onFinish={(values) => addMcpMut.mutate(values)}>
          <Form.Item label="Name" name="name" rules={[{ required: true }]}>
            <Input placeholder="e.g. my-mcp-server" />
          </Form.Item>
          <Form.Item label="URL" name="url" rules={[{ required: true }]}>
            <Input placeholder="https://..." />
          </Form.Item>
          <Form.Item label="Auth type" name="authType" initialValue="none">
            <Select
              options={[
                { value: 'none', label: 'None' },
                { value: 'bearer', label: 'Bearer token' },
                { value: 'oauth', label: 'OAuth' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
