// Data & retention — rules and built-in defaults. Moved verbatim from
// `Settings.tsx` (§4.2 row 15).

import { Button, Card, Input, Select, Typography } from 'antd';
import type { Dispatch, SetStateAction } from 'react';
import { RowLabel } from '../components/primitives';
import {
  type PersonalityOption,
  RETENTION_SUBKEYS,
  type RetentionSubkey,
} from '../lib/config-types';
import { nextRowId } from '../lib/row-id';
import type { RetentionRow } from '../lib/rows';
import { useSettingsPane } from '../pane-context';

export function DataPane() {
  const { showAdvanced, retentionRows, setRetentionRows, personalities } = useSettingsPane();
  if (!showAdvanced) return null;
  return (
    <RetentionCard rows={retentionRows} setRows={setRetentionRows} personalities={personalities} />
  );
}

function RetentionCard({
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
    <Card title="Agent data retention" size="small" style={{ marginBottom: 16 }}>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
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
    </Card>
  );
}
