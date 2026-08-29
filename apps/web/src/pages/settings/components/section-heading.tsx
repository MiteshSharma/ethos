// SectionHeading — the label above a group of `SettingRow`s (plan §6.2).
// DESIGN.md "micro / section labels": 11px / 500 / uppercase / 0.08em,
// `--text-tertiary`. Not a `Card` — a heading is enough to separate one
// section of a category from the next (DESIGN.md "Cards earn existence").
//
// `id` is the section's slug from `taxonomy.ts`, when the pane has one to
// give — it is what a future per-section anchor link would target.

import type { ReactNode } from 'react';

export function SectionHeading({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h3 id={id} className="settings-section-heading">
      {children}
    </h3>
  );
}
