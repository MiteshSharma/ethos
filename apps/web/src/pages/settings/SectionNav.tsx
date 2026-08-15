// Sticky tabs across the top of the detail pane (plan §6.1). Renders only when
// the active category has more than one section — every category in the
// taxonomy does today, but the check is what keeps this generic rather than
// tied to the four Agent-group categories Phase 3 converts.
//
// Section order is the taxonomy's own order (`SettingsCategory.sections` in
// `lib/taxonomy.ts`) — the same order the rail's counts and Phase 2's search
// already read, so there is no second place a section's position is decided.
//
// Navigating between sections of the SAME category is a normal push, not a
// `replace`: `resolveSettingsRoute`'s `replace: true` is for correcting a URL
// the user did not choose (an unknown or missing section), not for a
// deliberate move they may want to Back through (D5).
//
// Sits in the shell, OUTSIDE the `<Form>`, beside the `<Outlet/>` it does not
// wrap (§5.3) — it is chrome for the detail column, not a pane, and it must
// never become a place a page-Save-backed field could be mounted.

import { Link } from 'react-router-dom';
import type { SettingsCategory } from './lib/taxonomy';

export function SectionNav({
  category,
  activeSection,
}: {
  category: SettingsCategory | undefined;
  activeSection: string;
}) {
  if (!category || category.sections.length <= 1) return null;
  return (
    <nav className="settings-section-nav" aria-label="Section">
      {category.sections.map((section) => (
        <Link
          key={section.slug}
          to={`/settings/${category.slug}/${section.slug}`}
          className={`settings-section-nav-tab${section.slug === activeSection ? ' active' : ''}`}
        >
          {section.label}
        </Link>
      ))}
    </nav>
  );
}
