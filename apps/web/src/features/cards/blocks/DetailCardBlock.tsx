import type { CardBlockProps } from '../registry';
import { UnknownCardBlock } from './UnknownCardBlock';

// One record: title, optional state word, and its fields as a label/value
// grid. Labels take the micro section-label ramp, values the body ramp, so
// the grid scans vertically without rules or zebra striping.

export function DetailCardBlock({ card }: CardBlockProps) {
  if (card.kind !== 'detail') return <UnknownCardBlock card={card} />;
  const { title, status, fields } = card.payload;
  return (
    <div className="card-block card-detail">
      <div className="card-detail-head">
        <span className="card-title">{title}</span>
        {status ? <span className="card-chip">{status}</span> : null}
      </div>
      <dl className="card-detail-grid">
        {fields.map((field) => (
          <div key={field.label} className="card-detail-row">
            <dt className="card-detail-label">{field.label}</dt>
            <dd className="card-detail-value">{field.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
