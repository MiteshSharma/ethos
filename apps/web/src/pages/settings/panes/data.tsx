// Data & retention — rules and built-in defaults. Moved verbatim from
// `Settings.tsx` (§4.2 row 15), off `Card` onto `SectionHeading` (Phase 4).
//
// `built-in-defaults` is one of Phase 2's `EXPECTED_EMPTY_SECTIONS` — a
// read-only readout, same treatment as Models & providers' `per-personality
// routing`, not a place to force a control that would not otherwise exist.

import { RETENTION_DEFAULTS } from '@ethosagent/types';
import { Button, Input, Select, Typography } from 'antd';
import type { Dispatch, SetStateAction } from 'react';
import { AdvancedBlock } from '../components/advanced';
import { RowLabel } from '../components/primitives';
import { SectionHeading } from '../components/section-heading';
import {
  type PersonalityOption,
  RETENTION_SUBKEYS,
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
        built-in default; saving replaces the whole set.
      </Typography.Paragraph>
      {rows.map((row, idx) => (
        <div
          key={row._id}
          style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'flex-end' }}
        >
          <div style={{ flex: 1 }}>
            <RowLabel>Scope</RowLabel>
            <Select
              size="small"
              style={{ width: '100%' }}
              value={row.personalityId}
              onChange={(v: string) => update(idx, { personalityId: v })}
              options={[
                { value: '', label: 'Global' },
                ...personalities.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
          </div>
          <div style={{ flex: 1 }}>
            <RowLabel>Data</RowLabel>
            <Select
              size="small"
              style={{ width: '100%' }}
              value={row.subkey}
              onChange={(v: RetentionSubkey) => update(idx, { subkey: v })}
              options={RETENTION_SUBKEYS.map((s) => ({ value: s, label: s }))}
            />
          </div>
          <div style={{ width: 110 }}>
            <RowLabel>Duration</RowLabel>
            <Input
              size="small"
              placeholder="90d"
              value={row.duration}
              onChange={(e) => update(idx, { duration: e.target.value })}
            />
          </div>
          <Button size="small" danger onClick={() => remove(idx)}>
            Remove
          </Button>
        </div>
      ))}
      <Button type="dashed" size="small" onClick={add} style={{ width: '100%' }}>
        Add retention rule
      </Button>
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
  const entries: [string, string][] = [
    ['messages', RETENTION_DEFAULTS.messages],
    ['traces', RETENTION_DEFAULTS.traces],
    ['spans', RETENTION_DEFAULTS.spans],
    ['blobs', RETENTION_DEFAULTS.blobs],
    ['archive', RETENTION_DEFAULTS.archive],
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
