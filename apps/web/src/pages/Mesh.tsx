import type { MeshAgent } from '@ethosagent/web-contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { App as AntApp, Button, Empty, Form, Input, Spin, Table, Tag, Typography } from 'antd';
import { rpc } from '../rpc';

// Mesh tab — swarm pillar of v0.5.
//
// Two parts: a live table of registered agents (heartbeat-filtered, so
// stale registrations drop off automatically after 30s), and a route
// test that asks the mesh to pick a peer for a given capability without
// actually dispatching a task.

export function Mesh() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['mesh', 'list'],
    queryFn: () => rpc.mesh.list(),
    // The mesh's own staleness window is 30s — refresh at half that so
    // a peer dropping off shows up within 15s without polling too hard.
    refetchInterval: 15_000,
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
        Failed to load mesh: {(error as Error).message}
      </Typography.Text>
    );
  }

  const agents = data?.agents ?? [];

  return (
    <div className="mesh-tab">
      <header className="mesh-toolbar">
        <span className="mesh-count">
          {agents.length} {agents.length === 1 ? 'agent' : 'agents'} live
        </span>
        <Button onClick={() => void refetch()} loading={isFetching}>
          Refresh
        </Button>
      </header>

      <Table<MeshAgent>
        rowKey="agentId"
        dataSource={agents}
        pagination={false}
        size="small"
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No mesh peers registered. Run another `ethos serve` to see it here."
            />
          ),
        }}
        columns={[
          {
            title: 'Agent',
            dataIndex: 'agentId',
            key: 'agentId',
            render: (id: string) => <Typography.Text code>{id}</Typography.Text>,
          },
          {
            title: 'Capabilities',
            dataIndex: 'capabilities',
            key: 'capabilities',
            render: (caps: string[]) =>
              caps.length === 0 ? (
                <Typography.Text type="secondary">—</Typography.Text>
              ) : (
                <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {caps.map((c) => (
                    <Tag key={c} bordered={false}>
                      {c}
                    </Tag>
                  ))}
                </span>
              ),
          },
          {
            title: 'Active',
            dataIndex: 'activeSessions',
            key: 'activeSessions',
            width: 80,
            align: 'right',
          },
          {
            title: 'Last seen',
            dataIndex: 'lastSeenAt',
            key: 'lastSeenAt',
            width: 140,
            render: (iso: string) => formatRelative(iso),
          },
        ]}
      />

      <RouteTest />
    </div>
  );
}

function RouteTest() {
  const { notification } = AntApp.useApp();
  const [form] = Form.useForm<{ capability: string }>();

  const routeMut = useMutation({
    mutationFn: (capability: string) => rpc.mesh.routeTest({ capability }),
    onSuccess: (result) => {
      if (result.ok && result.routedTo) {
        notification.success({
          message: `Routed to ${result.routedTo}`,
          description: 'The mesh would dispatch a task with this capability to this peer.',
          placement: 'topRight',
        });
      } else {
        notification.warning({
          message: 'No peer available',
          description: result.reason ?? 'No live mesh agent advertises this capability.',
          placement: 'topRight',
        });
      }
    },
    onError: (err) =>
      notification.error({ message: 'Route failed', description: (err as Error).message }),
  });

  return (
    <section className="mesh-route-test" style={{ marginTop: 24 }}>
      <Typography.Title level={5}>Route test</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        Pick the agent the mesh would route a task to, given a capability. Doesn't dispatch any
        work.
      </Typography.Paragraph>
      <Form form={form} layout="inline" onFinish={(values) => routeMut.mutate(values.capability)}>
        <Form.Item
          name="capability"
          rules={[{ required: true, message: 'Required' }]}
          style={{ flexGrow: 1, minWidth: 240 }}
        >
          <Input placeholder="e.g. code, web, delegate" autoComplete="off" />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={routeMut.isPending}>
            Test
          </Button>
        </Form.Item>
      </Form>
    </section>
  );
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return iso;
  const diff = Date.now() - ts;
  if (diff < 1_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return new Date(iso).toLocaleString();
}
