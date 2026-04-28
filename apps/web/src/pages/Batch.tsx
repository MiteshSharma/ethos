import type { BatchRunInfo } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useState } from 'react';
import { rpc } from '../rpc';

// Lab → Batch tab. v1.
//
// Submit a tasks JSONL → server kicks off a BatchRunner → table polls
// every 2s for progress. Cancel-mid-run is deferred (the runner's
// existing checkpoint mechanism makes re-runs idempotent — start a new
// run with the same tasks file to resume).

const PLACEHOLDER = `{"id": "task-1", "prompt": "Summarize the README in two sentences."}\n{"id": "task-2", "prompt": "Write a haiku about deployment."}`;

export function Batch() {
  const [submitOpen, setSubmitOpen] = useState(false);

  const listQuery = useQuery({
    queryKey: ['batch', 'list'],
    queryFn: () => rpc.batch.list(),
    refetchInterval: 2000,
  });

  if (listQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (listQuery.error) {
    return (
      <Typography.Text type="danger">
        Failed to load batch runs: {(listQuery.error as Error).message}
      </Typography.Text>
    );
  }

  const runs = listQuery.data?.runs ?? [];

  return (
    <div className="lab-tab">
      <header className="lab-toolbar">
        <span className="lab-count">
          {runs.length} {runs.length === 1 ? 'run' : 'runs'}
        </span>
        <Button type="primary" onClick={() => setSubmitOpen(true)}>
          New batch
        </Button>
      </header>

      <Table<BatchRunInfo>
        rowKey="id"
        dataSource={runs}
        pagination={false}
        size="small"
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No batch runs yet. Submit one to start."
            />
          ),
        }}
        columns={[
          {
            title: 'Run',
            dataIndex: 'id',
            key: 'id',
            render: (id: string, run) => (
              <div>
                <div style={{ fontWeight: 500 }}>
                  <StatusTag status={run.status} />
                </div>
                <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11 }}>{id}</div>
              </div>
            ),
          },
          {
            title: 'Progress',
            key: 'progress',
            render: (_, run) => {
              const finished = run.completed + run.failed;
              const pct = run.total === 0 ? 0 : Math.round((finished / run.total) * 100);
              return (
                <div style={{ minWidth: 220 }}>
                  <Progress
                    percent={pct}
                    size="small"
                    status={
                      run.status === 'failed'
                        ? 'exception'
                        : run.status === 'running'
                          ? 'active'
                          : undefined
                    }
                  />
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
                    {run.completed} done · {run.failed} failed · {run.skipped} skipped · {run.total}{' '}
                    total
                  </div>
                </div>
              );
            },
          },
          {
            title: 'Started',
            dataIndex: 'startedAt',
            key: 'startedAt',
            width: 140,
            render: (iso: string) => formatRelative(iso),
          },
          {
            title: '',
            key: 'actions',
            width: 140,
            render: (_, run) => <BatchRowActions run={run} />,
          },
        ]}
      />

      {submitOpen ? <SubmitModal onClose={() => setSubmitOpen(false)} /> : null}
    </div>
  );
}

function StatusTag({ status }: { status: BatchRunInfo['status'] }) {
  const color =
    status === 'completed'
      ? 'success'
      : status === 'failed'
        ? 'error'
        : status === 'running'
          ? 'processing'
          : 'default';
  return <Tag color={color}>{status}</Tag>;
}

function BatchRowActions({ run }: { run: BatchRunInfo }) {
  const { notification } = AntApp.useApp();
  const downloadMut = useMutation({
    mutationFn: () => rpc.batch.output({ id: run.id }),
    onSuccess: (result) => {
      if (!result.content) {
        notification.info({ message: 'No output yet', placement: 'topRight' });
        return;
      }
      const blob = new Blob([result.content], { type: 'application/jsonl' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `batch-${run.id}.jsonl`;
      a.click();
      URL.revokeObjectURL(url);
    },
    onError: (err) =>
      notification.error({ message: 'Download failed', description: (err as Error).message }),
  });
  return (
    <Button size="small" onClick={() => downloadMut.mutate()} loading={downloadMut.isPending}>
      Download
    </Button>
  );
}

function SubmitModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [form] = Form.useForm<{
    tasksJsonl: string;
    concurrency: number;
    defaultPersonalityId: string;
  }>();

  const startMut = useMutation({
    mutationFn: (values: {
      tasksJsonl: string;
      concurrency: number;
      defaultPersonalityId: string;
    }) =>
      rpc.batch.start({
        tasksJsonl: values.tasksJsonl,
        concurrency: values.concurrency,
        ...(values.defaultPersonalityId
          ? { defaultPersonalityId: values.defaultPersonalityId }
          : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['batch', 'list'] });
      notification.success({ message: 'Batch run started', placement: 'topRight' });
      onClose();
    },
    onError: (err) =>
      notification.error({ message: 'Start failed', description: (err as Error).message }),
  });

  return (
    <Modal
      open
      title="New batch run"
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="Start"
      okButtonProps={{ loading: startMut.isPending }}
      destroyOnClose
      width={680}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ concurrency: 4, tasksJsonl: '', defaultPersonalityId: '' }}
        onFinish={(v) => startMut.mutate(v)}
      >
        <Form.Item
          label="Tasks (JSONL)"
          name="tasksJsonl"
          rules={[{ required: true, message: 'Required' }]}
          extra="One task per line. Each must have id (string) and prompt (string)."
        >
          <Input.TextArea
            rows={12}
            placeholder={PLACEHOLDER}
            style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}
          />
        </Form.Item>
        <Form.Item label="Concurrency" name="concurrency">
          <InputNumber min={1} max={16} />
        </Form.Item>
        <Form.Item
          label="Default personality"
          name="defaultPersonalityId"
          extra="Optional. Used for tasks that don't pin one."
        >
          <Input placeholder="e.g. researcher" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return iso;
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleString();
}
