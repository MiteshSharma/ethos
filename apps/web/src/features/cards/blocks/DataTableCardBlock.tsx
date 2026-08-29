import type { CardBlockProps } from '../registry';
import { UnknownCardBlock } from './UnknownCardBlock';

// Tabular data. Three rules from DESIGN.md do the work: numeric columns are
// right-aligned with tabular numerals, the totals row is separated by weight
// and a rule rather than a fill, and the whole table scrolls inside its own
// container so a wide table never widens the 800px chat column.

type Cell = string | number | null;

function renderCell(value: Cell | undefined): string {
  if (value === null || value === undefined) return '—';
  return String(value);
}

export function DataTableCardBlock({ card }: CardBlockProps) {
  if (card.kind !== 'data_table') return <UnknownCardBlock card={card} />;
  const { title, caption, columns, rows, totals } = card.payload;
  return (
    <div className="card-block card-table">
      {title ? <div className="card-title">{title}</div> : null}
      <div className="card-table-scroll">
        <table className="card-table-el">
          {caption ? <caption className="card-table-caption">{caption}</caption> : null}
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  className={`card-table-head-cell${col.numeric ? ' card-table-numeric' : ''}`}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              // Rows carry no identity of their own — the payload is a bag of
              // cells — so the index is the only stable key available.
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id field in the schema
              <tr key={rowIdx}>
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`card-table-cell${col.numeric ? ' card-table-numeric' : ''}`}
                  >
                    {renderCell(row[col.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {totals ? (
            <tfoot>
              <tr className="card-table-totals">
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`card-table-cell${col.numeric ? ' card-table-numeric' : ''}`}
                  >
                    {renderCell(totals[col.key])}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </div>
  );
}
