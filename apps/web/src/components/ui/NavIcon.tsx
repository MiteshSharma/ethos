// 16px stroke icons for nav rows — DESIGN.md "Sidebar → Icons": every nav
// item carries a `stroke="currentColor"`, `strokeWidth="1.5"`, `fill="none"`
// SVG. Paths are the prototype's (`plan/prototypes/teams-as-a-scope/
// ethos-team-scope.html`, `ICONS`), one entry per DESIGN.md icon assignment
// used by the team column. Sized by the `.sidebar-nav-item svg` rule.

export type NavIconKey =
  | 'chat'
  | 'overview'
  | 'board'
  | 'structure'
  | 'memory'
  | 'activity'
  | 'channels'
  | 'settings';

const PATHS: Record<NavIconKey, string> = {
  chat: 'M2 3h12v8H6l-3 3v-3H2z',
  overview: 'M2 8l6-5 6 5v6H2z',
  board: 'M2 2h3v12H2zM6.5 2h3v8h-3zM11 2h3v10h-3z',
  structure:
    'M10 3a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM5 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM15 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM8 5v3M8 8l-4 2M8 8l4 2',
  memory:
    'M5 2c-2 0-3 1.5-3 3 0 1-1 2 0 3.5S3 12 5 12h1V2zM11 2c2 0 3 1.5 3 3 0 1 1 2 0 3.5S13 12 11 12h-1V2z',
  activity: 'M2 8h12M2 4h8M2 12h8',
  channels: 'M2 3h12v10H2zM2 5l6 4 6-4',
  settings:
    'M10.5 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3',
};

export function NavIcon({ icon }: { icon: NavIconKey }) {
  return (
    <svg
      aria-hidden="true"
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[icon]} />
    </svg>
  );
}
