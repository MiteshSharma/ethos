import { useState } from 'react';
import type { CardBlockProps } from '../registry';
import { UnknownCardBlock } from './UnknownCardBlock';

// Follow-ups as pills. Same affordance as the empty-state suggestion pills —
// `.empty-state-pill` is that mechanic, so this reuses the class rather than
// growing a second pill style; only the layout (inline row, not a 2×2 grid)
// differs.
//
// When the card asks a question, the pills are a choice: picking one settles
// it, so the rest disable. Without a question they are standing shortcuts and
// stay live.

export interface ActionPill {
  label: string;
  prompt: string;
}

/**
 * The pills themselves — deliberately hook-free, so the click contract can be
 * exercised by calling this function and invoking the returned element's
 * `onClick`. The apps/web suite renders to static markup and has no DOM.
 */
export function ActionPills({
  actions,
  disabled,
  onPick,
}: {
  actions: readonly ActionPill[];
  disabled: boolean;
  onPick: (prompt: string) => void;
}) {
  return (
    <div className="card-actions-pills">
      {actions.map((action) => (
        <button
          key={action.prompt}
          type="button"
          className="empty-state-pill card-actions-pill"
          disabled={disabled}
          onClick={() => onPick(action.prompt)}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

export function RecommendActionsBlock({ card, onSuggestPrompt }: CardBlockProps) {
  const [picked, setPicked] = useState(false);
  if (card.kind !== 'recommend_actions') return <UnknownCardBlock card={card} />;
  const { question, actions } = card.payload;
  return (
    <div className="card-block card-actions">
      {question ? <div className="card-actions-question">{question}</div> : null}
      <ActionPills
        actions={actions}
        disabled={picked && question !== undefined}
        onPick={(prompt) => {
          setPicked(true);
          onSuggestPrompt?.(prompt);
        }}
      />
    </div>
  );
}
