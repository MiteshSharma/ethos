// The 8px state dot every team pane shares (plan/phases/teams-as-a-scope.md
// §4/§7): colour by meaning, never by personality, always beside text so the
// colour is not the only signal (DESIGN.md semantic-colour rule). `live` adds
// the pulse; `team-panes.css` stops it under `prefers-reduced-motion`.

export type DotTone = 'ok' | 'warn' | 'err' | 'info' | 'dim';

export function SeverityDot({ tone, live = false }: { tone: DotTone; live?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`team-dot team-dot-${tone}${live ? ' team-dot-live' : ''}`}
    />
  );
}
