// Data & retention — rules and built-in defaults. Moved verbatim from
// `Settings.tsx` (§4.2 row 15), off `Card` onto `SectionHeading` (Phase 4).
//
// `built-in-defaults` is one of Phase 2's `EXPECTED_EMPTY_SECTIONS` — a
// read-only readout, same treatment as Models & providers' `per-personality
// routing`, not a place to force a control that would not otherwise exist.

import { RETENTION_DEFAULTS, RETENTION_NO_PERSONALITY_SCOPE } from '@ethosagent/types';
import { Button, Form, Input, InputNumber, Select, Switch, Typography } from 'antd';
import type { Dispatch, SetStateAction } from 'react';
import { AdvancedBlock } from '../components/advanced';
import { SectionHeading } from '../components/section-heading';
import { SettingRow } from '../components/setting-row';
import { SettingTable } from '../components/setting-table';
import {
  type PersonalityOption,
  RETENTION_SUBKEYS,
  RETENTION_SUBKEYS_PER_PERSONALITY,
  type RetentionSubkey,
} from '../lib/config-types';
import { nextRowId } from '../lib/row-id';
import type { RetentionRow } from '../lib/rows';
import { useSettingsPane } from '../pane-context';

export function DataPane() {
  const { retentionRows, setRetentionRows, personalities } = useSettingsPane();
  return (
    <>
      <SectionHeading id="rules">rules</SectionHeading>
      {/* The rules editor is advanced end to end, so it used to render an
          empty pane with the toggle off. Dimmed, not unmounted (D10). */}
      <AdvancedBlock>
        <RetentionEditor
          rows={retentionRows}
          setRows={setRetentionRows}
          personalities={personalities}
        />
        <SettingRow
          label="VACUUM after a prune sweep"
          formName="retentionVacuumAfterPrune"
          help="Reclaim session-database file space once a prune has deleted rows (retention.vacuumAfterPrune, default off). A VACUUM rewrites the whole database and holds a write lock while it runs."
        >
          <Form.Item
            name="retentionVacuumAfterPrune"
            valuePropName="checked"
            style={{ marginBottom: 0 }}
          >
            <Switch />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Minimum days between VACUUMs"
          formName="retentionMinVacuumIntervalDays"
          help="Days that must pass before another VACUUM runs (retention.minVacuumIntervalDays). Blank or 0 = every prune sweep may vacuum."
        >
          <Form.Item name="retentionMinVacuumIntervalDays" style={{ marginBottom: 0 }}>
            <InputNumber min={0} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </SettingRow>
      </AdvancedBlock>

      <SectionHeading id="built-in-defaults">built-in defaults</SectionHeading>
      <BuiltInDefaults />
    </>
  );
}

function RetentionEditor({
  rows,
  setRows,
  personalities,
}: {
  rows: RetentionRow[];
  setRows: Dispatch<SetStateAction<RetentionRow[]>>;
  personalities: PersonalityOption[];
}) {
  const update = (index: number, patch: Partial<RetentionRow>) =>
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const remove = (index: number) => setRows((prev) => prev.filter((_, i) => i !== index));
  const add = () =>
    setRows((prev) => [
      ...prev,
      { _id: nextRowId(), personalityId: '', subkey: 'messages', duration: '' },
    ]);

  return (
    <>
      {/* "Agent data retention", not "Retention" — plan §8 0f: this and
          Desktop's "Desktop cache retention" used to be two Cards titled
          only "Data retention" / "Retention", indistinguishable at a glance. */}
      <Typography.Text strong style={{ fontSize: 13 }}>
        Agent data retention
      </Typography.Text>
      <Typography.Paragraph type="secondary" style={{ marginTop: 4 }}>
        TTLs for stored data (retention.&lt;subkey&gt;, or
        personalities.&lt;id&gt;.retention.&lt;subkey&gt; to override for one personality). Duration
        is &quot;forever&quot; or a number plus d/w/m/y, e.g. 90d. Unlisted subkeys keep the
        built-in default; saving replaces the whole set. A few subkeys are Global-only — the nightly
        prune reads no per-personality window for them, so the Personality column does not offer
        one.
      </Typography.Paragraph>
      <SettingTable<RetentionRow>
        rowKey={(row) => row._id}
        rows={rows}
        addLabel="Add retention rule"
        onAdd={add}
        emptyText="No retention rules yet."
        columns={[
          {
            key: 'personality',
            header: 'Personality',
            render: (row, idx) => (
              <Select
                size="small"
                style={{ width: '100%' }}
                value={row.personalityId}
                onChange={(v: string) => update(idx, { personalityId: v })}
                // A subkey the nightly prune only ever reads globally is
                // Global-only here, so the combination cannot be built from
                // either direction. See `RETENTION_SUBKEYS_PER_PERSONALITY`.
                options={[
                  { value: '', label: 'Global' },
                  ...(RETENTION_NO_PERSONALITY_SCOPE[row.subkey] === undefined
                    ? personalities.map((p) => ({ value: p.id, label: p.name }))
                    : []),
                ]}
              />
            ),
          },
          {
            key: 'scope',
            header: 'Scope',
            render: (row, idx) => (
              <Select
                size="small"
                style={{ width: '100%' }}
                value={row.subkey}
                onChange={(v: RetentionSubkey) => update(idx, { subkey: v })}
                options={(row.personalityId
                  ? RETENTION_SUBKEYS_PER_PERSONALITY
                  : RETENTION_SUBKEYS
                ).map((s) => ({ value: s, label: s }))}
              />
            ),
          },
          {
            key: 'days',
            header: 'Days',
            render: (row, idx) => (
              <Input
                size="small"
                placeholder="90d"
                value={row.duration}
                onChange={(e) => update(idx, { duration: e.target.value })}
              />
            ),
          },
          {
            key: 'actions',
            header: 'Actions',
            render: (_row, idx) => (
              <Button size="small" danger onClick={() => remove(idx)}>
                Remove
              </Button>
            ),
          },
        ]}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Built-in defaults (EXPECTED_EMPTY_SECTIONS) — the TTL applied to a data
// subkey when no rule above overrides it. Read-only, sourced from
// `RETENTION_DEFAULTS` (`@ethosagent/types`) so the numbers cannot drift from
// what the config layer actually applies.
// ---------------------------------------------------------------------------

function BuiltInDefaults() {
  // One entry per subkey the rules editor above can produce a row for. Written
  // out rather than derived because `RETENTION_DEFAULTS.events` is nested and
  // `RETENTION_SUBKEYS` is flat — which is how `channelTranscript` came to be
  // missing here while being editable there, hiding its 30d default for the one
  // category holding message text from people who never opted into an agent.
  // Drift is caught by `apps/web/src/pages/__tests__/retention-subkeys.test.ts`.
  const entries: [string, string][] = [
    ['messages', RETENTION_DEFAULTS.messages],
    ['traces', RETENTION_DEFAULTS.traces],
    ['spans', RETENTION_DEFAULTS.spans],
    ['blobs', RETENTION_DEFAULTS.blobs],
    ['archive', RETENTION_DEFAULTS.archive],
    ['channelTranscript', RETENTION_DEFAULTS.channelTranscript],
    ['events.error', RETENTION_DEFAULTS.events.error],
    ['events.audit', RETENTION_DEFAULTS.events.audit],
    ['events.channel', RETENTION_DEFAULTS.events.channel],
    ['events.install', RETENTION_DEFAULTS.events.install],
  ];
  return (
    <>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        The built-in TTL applied to a data subkey when no rule above overrides it.
      </Typography.Paragraph>
      <ul style={{ margin: 0, paddingLeft: 16 }}>
        {entries.map(([subkey, value]) => (
          <li key={subkey} style={{ fontSize: 13, color: 'var(--ethos-text)' }}>
            <Typography.Text code>{subkey}</Typography.Text>
            {' → '}
            <Typography.Text code>{value}</Typography.Text>
          </li>
        ))}
      </ul>
    </>
  );
}
