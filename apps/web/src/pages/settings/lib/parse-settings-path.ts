// `useLocation().pathname` → the category/section pair for the rail and nav to
// highlight. A layout route's `useParams` only sees the params its OWN path
// declares — `:category` and `:section` belong to the child route — so
// `SettingsShell` reads the URL directly instead. Pulled into its own pure
// function so the segment-index arithmetic can be tested without a DOM
// (D5/D8/D9 pattern): `/settings/voice/trunk`.split('/') is
// `['', 'settings', 'voice', 'trunk']` — index 0 is the empty string before the
// leading slash, index 1 is `settings` (the layout route's own segment), so the
// category is index 2 and the section is index 3.

export function parseSettingsPath(pathname: string): { category?: string; section?: string } {
  const [, , category, section] = pathname.split('/');
  return { category, section };
}
