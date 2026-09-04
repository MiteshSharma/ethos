import type { ReactNode } from 'react';

// The one row primitive the whole Recipes flow is drawn from: a bordered list
// whose rows are a fixed three-column grid — a 22px glyph gutter, the label
// and its one-line sub, and a right-aligned mono value.
//
// Every group in the flow (ready / needs you / optional / what this creates /
// what was applied) is this list with different rows, so the vertical rhythm
// is identical everywhere and a status glyph always lands in the same column.
// Built from raw primitives, not Antd's `List` or `Card`.

export function RecipeRowList({ children }: { children: ReactNode }) {
  return <ul className="recipe-rowlist">{children}</ul>;
}

export function RecipeRowItem({
  glyph,
  tone,
  label,
  detail,
  value,
}: {
  /** A status glyph (✓ ✗ ⚠ ! ○) or a neutral marker. Never decorative. */
  glyph?: string;
  tone?: 'ok' | 'no' | 'warn' | 'muted';
  label: ReactNode;
  detail?: ReactNode;
  /** The right-hand mono word — the row's verdict, id, or schedule. */
  value?: ReactNode;
}) {
  return (
    <li className="recipe-rowlist-row">
      <span className={`recipe-glyph${tone ? ` recipe-glyph--${tone}` : ''}`}>{glyph ?? ''}</span>
      <span className="recipe-rowlist-key">
        <span className="recipe-rowlist-label">{label}</span>
        {detail !== undefined && detail !== '' ? (
          <span className="recipe-rowlist-sub">{detail}</span>
        ) : null}
      </span>
      {value !== undefined ? <span className="recipe-rowlist-value">{value}</span> : null}
    </li>
  );
}

/**
 * A bordered aside with a 2px accent rule down its left edge. Used for the
 * things that are true whether or not the user acts — the honest caveats the
 * flow refuses to bury.
 */
export function RecipeCallout({
  title,
  tone = 'warning',
  children,
}: {
  title: string;
  tone?: 'warning' | 'info';
  children: ReactNode;
}) {
  return (
    <div className={`recipe-callout${tone === 'info' ? ' recipe-callout--info' : ''}`}>
      <div className="recipe-callout-title">{title}</div>
      <p className="recipe-callout-body">{children}</p>
    </div>
  );
}
