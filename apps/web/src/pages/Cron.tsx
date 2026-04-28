import type { CronJob } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Dropdown,
  Form,
  Input,
  type MenuProps,
  Modal,
  Popconfirm,
  Select,
  Spin,
  Table,
  Typography,
} from 'antd';
import { useState } from 'react';
import { rpc } from '../rpc';

// Cron tab — proactive pillar of v0.5. Lists scheduled jobs, lets the
// user create / pause / resume / delete / run-now, and shows the head
// of recent run history inline when a row is expanded.
//
// Server-side: serve.ts owns the actual scheduler tick loop. This UI
// just calls into rpc.cron.* and lets the backend do the work.

const PRESET_SCHEDULES: Array<{ value: string; label: string }> = [
  { value: '*/5 * * * *', label: 'Every 5 minutes' },
  { value: '0 * * * *', label: 'Hourly' },
  { value: '0 9 * * *', label: 'Daily at 9am' },
  { value: '0 9 * * 1-5', label: 'Weekdays at 9am' },
  { value: '0 8 * * 1', label: 'Mondays at 8am' },
];

export function Cron() {
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['cron', 'list'],
    queryFn: () => rpc.cron.list(),
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
        Failed to load cron jobs: {(error as Error).message}
      </Typography.Text>
    );
  }

  const jobs = data?.jobs ?? [];

  return (
    <div className="cron-tab">
      <header className="cron-toolbar">
        <span className="sessions-count">
          {jobs.length} {jobs.length === 1 ? 'job' : 'jobs'}
        </span>
        <Button type="primary" onClick={() => setCreateOpen(true)}>
          New job
        </Button>
      </header>

      <Table<CronJob>
        rowKey="id"
        dataSource={jobs}
        pagination={false}
        size="small"
        expandable={{
          expandedRowRender: (job) => <RunHistory jobId={job.id} />,
        }}
        locale={{
          emptyText: 'No cron jobs yet. Create one to schedule a recurring agent task.',
        }}
        columns={[
          {
            title: 'Name',
            dataIndex: 'name',
            render: (v: string, row) => (
              <span style={{ fontWeight: row.status === 'paused' ? 400 : 500 }}>
                {v}
                {row.status === 'paused' ? (
                  <span className="cron-status-paused"> · paused</span>
                ) : null}
              </span>
            ),
          },
          {
            title: 'Schedule',
            dataIndex: 'schedule',
            width: 160,
            render: (v: string) => <span className="sessions-mono">{v}</span>,
          },
          {
            title: 'Personality',
            dataIndex: 'personality',
            width: 130,
            render: (v: string | null) => v ?? '—',
          },
          {
            title: 'Next run',
            dataIndex: 'nextRunAt',
            width: 180,
            render: (v: string | null, row) =>
              row.status === 'paused' ? (
                <span className="cron-muted">—</span>
              ) : v ? (
                <span className="sessions-mono">{formatRelativeFuture(v)}</span>
              ) : (
                <span className="cron-muted">never</span>
              ),
          },
          {
            title: 'Last run',
            dataIndex: 'lastRunAt',
            width: 160,
            render: (v: string | null) =>
              v ? (
                <span className="sessions-mono">{formatRelativePast(v)}</span>
              ) : (
                <span className="cron-muted">never</span>
              ),
          },
          {
            title: '',
            width: 56,
            align: 'right' as const,
            render: (_v, row) => <RowActions job={row} />,
          },
        ]}
      />

      {createOpen ? <CreateJobModal open onClose={() => setCreateOpen(false)} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row actions (run-now / pause / resume / delete)
// ---------------------------------------------------------------------------

function RowActions({ job }: { job: CronJob }) {
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['cron', 'list'] });
  };

  const runNow = useMutation({
    mutationFn: () => rpc.cron.runNow({ id: job.id }),
    onSuccess: (result) => {
      invalidate();
      notification.success({
        message: `${job.name} ran`,
        description: result.output.slice(0, 200) || '(no output)',
        placement: 'topRight',
      });
    },
    onError: (err) => surfaceError(notification, 'Run failed', err),
  });

  const pause = useMutation({
    mutationFn: () => rpc.cron.pause({ id: job.id }),
    onSuccess: invalidate,
    onError: (err) => surfaceError(notification, 'Pause failed', err),
  });

  const resume = useMutation({
    mutationFn: () => rpc.cron.resume({ id: job.id }),
    onSuccess: invalidate,
    onError: (err) => surfaceError(notification, 'Resume failed', err),
  });

  const remove = useMutation({
    mutationFn: () => rpc.cron.delete({ id: job.id }),
    onSuccess: invalidate,
    onError: (err) => surfaceError(notification, 'Delete failed', err),
  });

  const items: MenuProps['items'] = [
    { key: 'run', label: 'Run now' },
    {
      key: 'toggle',
      label: job.status === 'paused' ? 'Resume' : 'Pause',
    },
    {
      key: 'delete',
      label: (
        <Popconfirm
          title="Delete this job?"
          description="The schedule and run history are removed."
          okText="Delete"
          okButtonProps={{ danger: true, loading: remove.isPending }}
          cancelText="Cancel"
          onConfirm={(e) => {
            e?.stopPropagation();
            remove.mutate();
          }}
        >
          <span style={{ color: '#f87171' }}>Delete</span>
        </Popconfirm>
      ),
    },
  ];

  return (
    <div className="sessions-row-actions" onClick={(e) => e.stopPropagation()}>
      <Dropdown
        menu={{
          items,
          onClick: ({ key, domEvent }) => {
            domEvent.stopPropagation();
            if (key === 'run') runNow.mutate();
            else if (key === 'toggle') {
              if (job.status === 'paused') resume.mutate();
              else pause.mutate();
            }
          },
        }}
        trigger={['click']}
        placement="bottomRight"
      >
        <button type="button" className="sessions-row-trigger" aria-label="Job actions">
          <DotsIcon />
        </button>
      </Dropdown>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create job modal
// ---------------------------------------------------------------------------

interface CreateForm {
  name: string;
  schedule: string;
  prompt: string;
  personality?: string;
}

function CreateJobModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm<CreateForm>();
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();

  const personalities = useQuery({
    queryKey: ['personalities'],
    queryFn: () => rpc.personalities.list(),
  });

  const create = useMutation({
    mutationFn: (input: CreateForm) =>
      rpc.cron.create({
        name: input.name,
        schedule: input.schedule,
        prompt: input.prompt,
        ...(input.personality ? { personality: input.personality } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['cron', 'list'] });
      form.resetFields();
      onClose();
    },
    onError: (err) => surfaceError(notification, 'Could not create job', err),
  });

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="Create"
      okButtonProps={{ loading: create.isPending }}
      title="New cron job"
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        onFinish={(values) => create.mutate(values)}
      >
        <Form.Item
          label="Name"
          name="name"
          rules={[{ required: true, message: 'A short name to identify the job' }]}
        >
          <Input placeholder="daily-news" autoFocus />
        </Form.Item>

        <Form.Item
          label="Schedule"
          name="schedule"
          rules={[{ required: true, message: 'A 5-field cron expression' }]}
          extra="Standard 5-field cron (minute hour day-of-month month day-of-week)."
        >
          <Select
            showSearch
            allowClear
            placeholder="0 9 * * 1-5  or pick a preset"
            options={PRESET_SCHEDULES.map((p) => ({
              value: p.value,
              label: `${p.label}  ·  ${p.value}`,
            }))}
            mode="tags"
            maxTagCount={1}
            // mode=tags lets users type a custom expression in addition to picking a preset.
            // Limit to one tag so the form value stays a single string.
            onChange={(values: string[]) => {
              const last = values[values.length - 1];
              form.setFieldsValue({ schedule: last ?? '' });
            }}
          />
        </Form.Item>

        <Form.Item
          label="Prompt"
          name="prompt"
          rules={[{ required: true, message: 'What should the agent do?' }]}
        >
          <Input.TextArea
            rows={4}
            placeholder="Summarize the latest issues from openclaw and email me the top 5."
          />
        </Form.Item>

        <Form.Item label="Personality (optional)" name="personality">
          <Select
            allowClear
            placeholder="Defaults to your active personality"
            loading={personalities.isLoading}
            options={(personalities.data?.personalities ?? []).map((p) => ({
              value: p.id,
              label: p.name,
            }))}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Run history (expanded row)
// ---------------------------------------------------------------------------

function RunHistory({ jobId }: { jobId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['cron', 'history', jobId],
    queryFn: () => rpc.cron.history({ id: jobId, limit: 5 }),
  });

  if (isLoading) {
    return (
      <div style={{ padding: 12 }}>
        <Spin size="small" />
      </div>
    );
  }

  if (error) {
    return (
      <Typography.Text type="danger">
        Could not load history: {(error as Error).message}
      </Typography.Text>
    );
  }

  const runs = data?.runs ?? [];
  if (runs.length === 0) {
    return <span className="cron-muted">No runs yet.</span>;
  }

  return (
    <div className="cron-history">
      {runs.map((run, idx) => (
        <div key={run.outputPath} className="cron-history-row">
          <span className="sessions-mono cron-history-when">{formatRelativePast(run.ranAt)}</span>
          {idx === 0 && run.output ? (
            <pre className="cron-history-output">{run.output.slice(0, 2000)}</pre>
          ) : (
            <span className="cron-muted">{idx === 0 ? '(no output)' : '(expand head only)'}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function DotsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="7" r="1.3" />
      <circle cx="7" cy="7" r="1.3" />
      <circle cx="11" cy="7" r="1.3" />
    </svg>
  );
}

function formatRelativePast(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (diff < 60_000) return 'just now';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatRelativeFuture(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = then - Date.now();
  if (diff < 0) return 'overdue';
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'in <1m';
  if (min < 60) return `in ${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `in ${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `in ${d}d`;
  return new Date(iso).toLocaleDateString();
}

function surfaceError(
  notification: ReturnType<typeof AntApp.useApp>['notification'],
  title: string,
  err: unknown,
): void {
  notification.error({
    message: title,
    description: err instanceof Error ? err.message : String(err),
    placement: 'topRight',
  });
}
