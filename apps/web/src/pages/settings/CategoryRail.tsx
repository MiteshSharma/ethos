// The 240px navigation column. Three group headers, one row per category,
// active state read off the URL.
//
// Counts, status dots, search and the advanced toggle are Phase 2 — this is the
// minimum that makes the surface addressable. Not a `Card` (DESIGN.md:134).

import { Link } from 'react-router-dom';
import { categoryHref, SETTINGS_GROUPS, type SettingsCategory } from './lib/taxonomy';

export function CategoryRail({
  categories,
  activeCategory,
}: {
  categories: SettingsCategory[];
  activeCategory: string;
}) {
  return (
    <nav className="settings-rail" aria-label="Settings categories">
      {SETTINGS_GROUPS.map((group) => {
        const rows = categories.filter((c) => c.group === group);
        if (rows.length === 0) return null;
        return (
          <div key={group} className="settings-rail-group">
            <div className="settings-rail-group-label">{group}</div>
            {rows.map((category) => (
              <Link
                key={category.slug}
                to={categoryHref(category)}
                className={`settings-rail-row${category.slug === activeCategory ? ' active' : ''}`}
              >
                {category.label}
              </Link>
            ))}
          </div>
        );
      })}
    </nav>
  );
}
