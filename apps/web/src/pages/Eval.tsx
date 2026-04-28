import type { EvalRunInfo, EvalScorer } from '@ethosagent/web-contracts';
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
  Select,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useState } from 'react';
import { rpc } from '../rpc';

// Lab → Eval tab. v1.
//
// Twin of Batch with an expected JSONL + scorer. Mirrors the BatchRunner
// runtime via the EvalRunner; the LabService backs both. Per-task
// pass/fail + aggregate score come from the runner directly.

const TASKS_PLACEHOLDER = `{"id": "q1", "prompt": "What is 2 + 2?"}\n{"id": "q2", "prompt": "Capital of France?"}`;
const EXPECTED_PLACEHOLDER = `{"id": "q1", "expected": "4"}\n{"id": "q2", "expected": "Paris"}`;

export function Eval() {
  const [submitOpen, setSubmitOpen] = useState(false);

  const listQuery = useQuery({
    queryKey: ['eval', 'list'],
    queryFn: () => rpc.eval.list(),
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
        Failed to load eval runs: {(listQuery.error as Error).message}
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
          New eval
        </Button>
      </header>

      <Table<EvalRunInfo>
        rowKey="id"
        dataSource={runs}
        pagination={false}
        size="small"
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No eval runs yet. Submit one to start."
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
                  <Tag bordered={false} style={{ marginLeft: 4 }}>
                    {run.scorer}
                  </Tag>
                </div>
                <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11 }}>{id}</div>
              </div>
            ),
          },
          {
            title: 'Progress',
            key: 'progress',
            render: (_, run) => {
              const finished = run.passed + run.failed;
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
                    {run.passed} pass · {run.failed} fail · {run.total} total
                  </div>
                </div>
              );
            },
          },
          {
            title: 'Score',
            dataIndex: 'avgScore',
            key: 'avgScore',
            width: 100,
            render: (score: number) => `${(score * 100).toFixed(1)}%`,
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
            render: (_, run) => <EvalRowActions run={run} />,
          },
        ]}
      />

      {submitOpen ? <SubmitModal onClose={() => setSubmitOpen(false)} /> : null}
    </div>
  );
}

function StatusTag({ status }: { status: EvalRunInfo['status'] }) {
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

function EvalRowActions({ run }: { run: EvalRunInfo }) {
  const { notification } = AntApp.useApp();
  const downloadMut = useMutation({
    mutationFn: () => rpc.eval.output({ id: run.id }),
    onSuccess: (result) => {
      if (!result.content) {
        notification.info({ message: 'No output yet', placement: 'topRight' });
        return;
      }
      const blob = new Blob([result.content], { type: 'application/jsonl' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `eval-${run.id}.jsonl`;
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
    expectedJsonl: string;
    scorer: EvalScorer;
    concurrency: number;
  }>();

  const startMut = useMutation({
    mutationFn: (values: {
      tasksJsonl: string;
      expectedJsonl: string;
      scorer: EvalScorer;
      concurrency: number;
    }) =>
      rpc.eval.start({
        tasksJsonl: values.tasksJsonl,
        expectedJsonl: values.expectedJsonl,
        scorer: values.scorer,
        concurrency: values.concurrency,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['eval', 'list'] });
      notification.success({ message: 'Eval run started', placement: 'topRight' });
      onClose();
    },
    onError: (err) =>
      notification.error({ message: 'Start failed', description: (err as Error).message }),
  });

  return (
    <Modal
      open
      title="New eval run"
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="Start"
      okButtonProps={{ loading: startMut.isPending }}
      destroyOnClose
      width={720}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          tasksJsonl: '',
          expectedJsonl: '',
          scorer: 'contains' as EvalScorer,
          concurrency: 4,
        }}
        onFinish={(v) => startMut.mutate(v)}
      >
        <Form.Item
          label="Tasks (JSONL)"
          name="tasksJsonl"
          rules={[{ required: true, message: 'Required' }]}
          extra="Each line: { id, prompt }."
        >
          <Input.TextArea
            rows={8}
            placeholder={TASKS_PLACEHOLDER}
            style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}
          />
        </Form.Item>
        <Form.Item
          label="Expected (JSONL)"
          name="expectedJsonl"
          rules={[{ required: true, message: 'Required' }]}
          extra="Each line: { id, expected, match? }. match override per row is optional."
        >
          <Input.TextArea
            rows={6}
            placeholder={EXPECTED_PLACEHOLDER}
            style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}
          />
        </Form.Item>
        <Form.Item label="Scorer" name="scorer">
          <Select
            options={[
              { label: 'contains (default)', value: 'contains' },
              { label: 'exact', value: 'exact' },
              { label: 'regex', value: 'regex' },
              { label: 'llm (judge)', value: 'llm' },
            ]}
          />
        </Form.Item>
        <Form.Item label="Concurrency" name="concurrency">
          <InputNumber min={1} max={16} />
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
