import { ContentRenderer } from '@ethosagent/ui-components';
import type { CardBlockProps } from '../registry';
import { UnknownCardBlock } from './UnknownCardBlock';

// Markdown prose through the same pipeline `TextBlock` uses, so a card body
// and an assistant paragraph are typographically identical. No container:
// prose does not earn a box (DESIGN.md, "cards earn existence").

export function TextCardBlock({ card }: CardBlockProps) {
  if (card.kind !== 'text') return <UnknownCardBlock card={card} />;
  const { title, text } = card.payload;
  return (
    <div className="card-block card-text">
      {title ? <div className="card-title">{title}</div> : null}
      <ContentRenderer content={text} format="markdown" />
    </div>
  );
}
