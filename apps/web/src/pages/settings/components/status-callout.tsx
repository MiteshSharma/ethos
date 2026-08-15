// StatusCallout — the honesty marker for a control whose `SETTINGS_INDEX`
// entry carries a `status` (plan §6.2, §7, Phase 7). Rendered by `SettingRow`
// after the help text, still inside `.settings-row-info`.
//
// Icon + text, never colour alone (DESIGN.md "Semantic colors": "Used only to
// signal status, never as decoration. Always paired with an icon — never
// colour alone."). The glyph/colour pairing follows the established
// precedent in `pages/Goals.tsx`'s `STATUS_CONFIG` — plain text glyphs
// (✓/✗/⏳/—), not a new icon system and not `@ant-design/icons`.
//
// Copy is fixed and identical across every entry of a given kind — it is a
// statement about EFFECT ("nothing acts on this"), not about mechanism, so it
// does not vary per key.

import type { SettingStatus } from '../lib/settings-index';

/** `SettingStatus` minus `null` — the two kinds `StatusCallout` renders. */
export type StatusCalloutKind = Exclude<SettingStatus, null>;

const COPY: Record<StatusCalloutKind, { icon: string; text: string; className: string }> = {
  unread: {
    icon: '⏳',
    text: 'Accepted, currently unread',
    className: 'settings-status-callout--unread',
  },
  broken: {
    icon: '✗',
    text: 'This control does not work',
    className: 'settings-status-callout--broken',
  },
};

export function StatusCallout({ kind }: { kind: StatusCalloutKind }) {
  const { icon, text, className } = COPY[kind];
  return (
    <div className={`settings-status-callout ${className}`}>
      <span aria-hidden="true">{icon}</span> {text}
    </div>
  );
}
