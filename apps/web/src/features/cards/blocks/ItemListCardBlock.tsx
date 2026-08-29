import type { CardBlockProps } from '../registry';
import { UnknownCardBlock } from './UnknownCardBlock';

// A dense list, not a card grid: status dot, name, one meta line.
//
// `id` is an identifier, not a URL, and this app has no route that takes an
// arbitrary tool-supplied id — the resource could be a ticket, a file, a
// symbol, anything. Inventing a URL scheme here would produce dead links, so
// the id renders as secondary mono text and stays copyable. When a card kind
// ever ships a typed resource reference, that is the moment to link it.

const STATUS_LABELS = {
  ok: 'OK',
  warn: 'Warning',
  error: 'Error',
  neutral: 'Neutral',
} as const;

export function ItemListCardBlock({ card }: CardBlockProps) {
  if (card.kind !== 'item_list') return <UnknownCardBlock card={card} />;
  const { title, items } = card.payload;
  return (
    <div className="card-block card-item-list">
      {title ? <div className="card-title">{title}</div> : null}
      <ul className="card-item-rows">
        {items.map((item) => (
          <li key={item.id} className="card-item-row">
            <span
              className={`card-status-dot card-status-${item.status ?? 'neutral'}`}
              role="img"
              aria-label={STATUS_LABELS[item.status ?? 'neutral']}
            />
            <span className="card-item-name">{item.name}</span>
            <span className="card-item-id">{item.id}</span>
            {item.meta ? <span className="card-item-meta">{item.meta}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
