// Background jobs — limits, budgets, lifecycle. The `background.*` sub-agent
// pool caps, moved verbatim from `Settings.tsx` (§4.2 row 14), off `Card`
// onto `SettingRow` / `SectionHeading` (Phase 8).
//
// All three sections are advanced end to end (`SETTINGS_INDEX`), so with the
// toggle off this pane used to render one empty Card — a rail row you could
// click into and find blank. Each heading stays visible; only the controls
// dim (D10), the same treatment `data.tsx`'s "rules" section uses for a
// section that is advanced from top to bottom.

import { Form, InputNumber, Switch } from 'antd';
import { AdvancedBlock } from '../components/advanced';
import { SectionHeading } from '../components/section-heading';
import { SettingRow } from '../components/setting-row';
import type { FormShape } from '../lib/form-shape';

export function JobsPane() {
  return (
    <>
      <SectionHeading id="limits">limits</SectionHeading>
      <AdvancedBlock>
        <LimitsFields />
      </AdvancedBlock>

      <SectionHeading id="budgets">budgets</SectionHeading>
      <AdvancedBlock>
        <BudgetsFields />
      </AdvancedBlock>

      <SectionHeading id="lifecycle">lifecycle</SectionHeading>
      <AdvancedBlock>
        <LifecycleFields />
      </AdvancedBlock>
    </>
  );
}

function numberField(
  name: keyof FormShape['background'],
  label: string,
  extra: string,
  opts: { min: number; integer?: boolean } = { min: 0, integer: true },
) {
  return (
    <SettingRow label={label} formName={`background.${name}`} help={extra}>
      <Form.Item name={['background', name]} style={{ marginBottom: 0 }}>
        <InputNumber
          min={opts.min}
          {...(opts.integer === false ? {} : { precision: 0 })}
          style={{ width: '100%' }}
        />
      </Form.Item>
    </SettingRow>
  );
}

function LimitsFields() {
  return (
    <>
      <SettingRow
        label="Enable background sub-agents"
        formName="background.enabled"
        help="Allow spawning background jobs (background.enabled, default off)."
      >
        <Form.Item
          name={['background', 'enabled']}
          valuePropName="checked"
          style={{ marginBottom: 0 }}
        >
          <Switch />
        </Form.Item>
      </SettingRow>
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
    </>
  );
}

function BudgetsFields() {
  return (
    <>
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
    </>
  );
}

function LifecycleFields() {
  return (
    <>
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
    </>
  );
}
