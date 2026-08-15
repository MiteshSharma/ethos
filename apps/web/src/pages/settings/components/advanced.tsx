// Advanced controls DIM. They never unmount (plan/phases/settings-navigation.md
// D10).
//
// Every one of these blocks used to be `{showAdvanced && …}`, which had two
// costs. The small one: an unmounted `Form.Item` leaves its value in the store
// only because `preserve` is on, so the page leaned on that mechanism for
// something layout could do instead. The large one: two whole categories —
// Background jobs and Data & retention — are advanced end to end, so with the
// toggle off they rendered an EMPTY pane. A category you can navigate to and
// find blank is worse than one you cannot navigate to at all.
//
// Dim, and still interactive: a control you can see and cannot touch is a trap,
// not a hint. So no `disabled`, no `pointer-events: none`, no `inert` — the
// treatment is opacity and nothing else, and T8
// (`__tests__/settings-advanced-dims.test.ts`) fails if a `disabled` or a
// re-introduced unmount creeps back.

import type { ReactNode } from 'react';
import { useSettingsPane } from '../pane-context';

/** The one class the dim treatment lives behind. See `styles.css`. */
export const ADVANCED_DIM_CLASS = 'settings-advanced-dim';

export function AdvancedBlock({ children }: { children: ReactNode }) {
  const { showAdvanced } = useSettingsPane();
  return (
    <div
      className={showAdvanced ? 'settings-advanced' : `settings-advanced ${ADVANCED_DIM_CLASS}`}
      data-advanced="true"
    >
      {children}
    </div>
  );
}
