// Advanced controls always render normally now — no dim, no toggle
// (plan/phases/settings-navigation.md D10 superseded).
//
// This used to gate on `showAdvanced` and apply an opacity dim (D10), which was
// itself a fix for an even older behavior where these blocks were literally
// `{showAdvanced && …}` and unmounted from the DOM when off. Unmounting broke
// two whole categories — Background jobs and Data & retention, which are
// advanced end to end — rendering them completely empty. The toggle and its
// dim treatment are gone; every control just always renders, mounted and at
// full opacity.

import type { ReactNode } from 'react';

export function AdvancedBlock({ children }: { children: ReactNode }) {
  return <div className="settings-advanced">{children}</div>;
}
