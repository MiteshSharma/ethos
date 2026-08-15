// Background jobs — limits, budgets, lifecycle. The `background.*` sub-agent
// pool caps, moved verbatim from `Settings.tsx` (§4.2 row 14).

import { Card, Form, InputNumber, Switch } from 'antd';
import type { FormShape } from '../lib/form-shape';
import { useSettingsPane } from '../pane-context';

export function JobsPane() {
  const { showAdvanced } = useSettingsPane();
  if (!showAdvanced) return null;
  return <BackgroundJobsCard />;
}

function BackgroundJobsCard() {
  const numberField = (
    name: keyof FormShape['background'],
    label: string,
    extra: string,
    opts: { min: number; integer?: boolean } = { min: 0, integer: true },
  ) => (
    <Form.Item label={label} name={['background', name]} extra={extra}>
      <InputNumber
        min={opts.min}
        {...(opts.integer === false ? {} : { precision: 0 })}
        style={{ width: '100%' }}
      />
    </Form.Item>
  );

  return (
    <Card title="Background jobs" size="small" style={{ marginBottom: 16 }}>
      <Form.Item
        label="Enable background sub-agents"
        name={['background', 'enabled']}
        valuePropName="checked"
        extra="Allow spawning background jobs (background.enabled, default off)."
      >
        <Switch />
      </Form.Item>
      {numberField(
        'maxConcurrentJobs',
        'Max concurrent jobs',
        'Jobs running at once (background.max_concurrent_jobs, default 2).',
        { min: 1 },
      )}
      {numberField(
        'maxJobsPerRoot',
        'Max jobs per root session',
        'Cap per root session (background.max_jobs_per_root, default 3).',
        { min: 1 },
      )}
      {numberField(
        'maxJobsPerPersonality',
        'Max jobs per personality',
        'Cap per personality (background.max_jobs_per_personality, default 5).',
        { min: 1 },
      )}
      {numberField(
        'defaultMaxCostUsd',
        'Default job budget (USD)',
        'Per-job spend cap (background.default_max_cost_usd, default 1).',
        { min: 0, integer: false },
      )}
      {numberField(
        'maxRootBackgroundUsd',
        'Root budget (USD)',
        'Total background spend per root session (background.max_root_background_usd, default 5).',
        { min: 0, integer: false },
      )}
      {numberField(
        'queuedTtlMs',
        'Queued TTL (ms)',
        'How long a queued job may wait before expiring (background.queued_ttl_ms, default 900000).',
        { min: 0 },
      )}
      {numberField(
        'staleMs',
        'Stale after (ms)',
        'A job with no heartbeat for this long counts as stale (background.stale_ms, default 90000).',
        { min: 0 },
      )}
      {numberField(
        'heartbeatMs',
        'Heartbeat interval (ms)',
        'How often running jobs report liveness (background.heartbeat_ms, default 30000).',
        { min: 0 },
      )}
      {numberField(
        'retentionDays',
        'Job retention (days)',
        'Days finished job records are kept (background.retention_days, default 30).',
        { min: 1 },
      )}
    </Card>
  );
}
