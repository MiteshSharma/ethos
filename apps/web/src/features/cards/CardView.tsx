import { Suspense } from 'react';
import { type CardBlockProps, resolveCardRenderer } from './registry';

// One card, rendered. The Suspense boundary exists for the lazy `canvas`
// entry; every other kind resolves synchronously and passes straight through.

export function CardView({ card, onSuggestPrompt }: CardBlockProps) {
  const Renderer = resolveCardRenderer(card.kind, card.specVersion);
  return (
    <Suspense fallback={<div className="card-chart-loading">Loading…</div>}>
      <Renderer card={card} onSuggestPrompt={onSuggestPrompt} />
    </Suspense>
  );
}
