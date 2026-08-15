// SettingTable — the roster/row-editor replacement for the stacked
// bordered-box-per-row shape (plan §6.2, §6.3, Phase 6). A real `<thead>` /
// `<tbody>`, not a `Card` (DESIGN.md "Cards earn existence") — the same shape
// the named-secrets and API-keys sections already render via antd `Table`,
// reproduced here in plain HTML because these rosters' rows are not
// `ColumnsType`-friendly: several columns render a DIFFERENT control
// depending on another field in the same row (a command template instead of
// a base URL, a format select instead of a per-minute rate).
//
// State-backed only: every column's `render` reads and writes the row array
// the caller already owns (`ProviderRow[]`, `VoiceProviderRow[]`, …) — this
// component adds no state and changes no patch shape. Add / remove / reorder
// stay the caller's own handlers, unchanged from before the conversion.
//
// `advanced` reuses Phase 2's dim treatment (`components/advanced.tsx`)
// verbatim, exactly as `SettingRow` does — a column cannot "unmount" without
// breaking every other row's shape, so dimming a column means dimming its
// header and its cells, never hiding them (D10).

import { Button } from 'antd';
import type { ReactNode } from 'react';
import { AdvancedBlock } from './advanced';

export interface SettingTableColumn<T> {
  key: string;
  header: ReactNode;
  /** Dims the header and every cell in this column (D10) — never unmounts. */
  advanced?: boolean;
  /** Tabular-mono treatment for literal/numeric columns (DESIGN.md "Typography"). */
  mono?: boolean;
  render: (row: T, index: number) => ReactNode;
}

export function SettingTable<T>({
  columns,
  rows,
  rowKey,
  addLabel,
  onAdd,
  emptyText,
}: {
  columns: SettingTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  /** Omit to render a table with no add affordance (read-only rosters). */
  addLabel?: string;
  onAdd?: () => void;
  emptyText?: string;
}) {
  return (
    <div className="settings-table-wrap">
      <table className="settings-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className="settings-table-th">
                {c.advanced ? <AdvancedBlock>{c.header}</AdvancedBlock> : c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="settings-table-empty" colSpan={columns.length}>
                {emptyText ?? 'None yet.'}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr key={rowKey(row)} className="settings-table-row">
                {columns.map((c) => {
                  const cell = c.render(row, index);
                  return (
                    <td
                      key={c.key}
                      className={`settings-table-td${c.mono ? ' settings-table-td-mono' : ''}`}
                    >
                      {c.advanced ? <AdvancedBlock>{cell}</AdvancedBlock> : cell}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
      {onAdd ? (
        <Button type="dashed" size="small" onClick={onAdd} className="settings-table-add">
          {addLabel ?? 'Add'}
        </Button>
      ) : null}
    </div>
  );
}
