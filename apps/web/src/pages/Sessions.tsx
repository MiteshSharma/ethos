import { useQuery } from '@tanstack/react-query';
import { Empty, Spin, Table, Typography } from 'antd';
import { rpc } from '../rpc';

// v0.W1: read-only sessions list against rpc.sessions.list. Useful as the
// first end-to-end "the wire works" check — if this table populates, the
// auth cookie + oRPC link + service container are all wired correctly.
// Pagination + FTS5 search land in 26.W4.

export function Sessions() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['sessions', 'list'],
    queryFn: () => rpc.sessions.list({ limit: 50 }),
  });

  if (isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
        <Spin />
      </div>
    );
  }

  if (error) {
    return (
      <Typography.Text type="danger">
        Failed to load sessions: {(error as Error).message}
      </Typography.Text>
    );
  }

  if (!data || data.sessions.length === 0) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
        <Empty description="No sessions yet. Start a chat to create one." />
      </div>
    );
  }

  return (
    <Table
      rowKey="id"
      dataSource={data.sessions}
      pagination={false}
      columns={[
        { title: 'ID', dataIndex: 'id', ellipsis: true, width: 200 },
        { title: 'Platform', dataIndex: 'platform', width: 100 },
        { title: 'Personality', dataIndex: 'personalityId', width: 160 },
        { title: 'Model', dataIndex: 'model', ellipsis: true },
        {
          title: 'Updated',
          dataIndex: 'updatedAt',
          width: 200,
          render: (v: string) => new Date(v).toLocaleString(),
        },
      ]}
    />
  );
}
