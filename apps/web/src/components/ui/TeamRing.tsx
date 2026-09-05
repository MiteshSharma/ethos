import { teamRingArcs, teamRingGeometry } from '@ethosagent/web-contracts';

// The team's face (plan/phases/teams-as-a-scope.md D10; DESIGN.md "Altitude
// convention"): a segmented ring, one arc per member in that member's accent,
// manifest order from 12 o'clock, over a faint neutral fill. Geometry comes
// from `teamRingArcs` in `@ethosagent/web-contracts` so every surface draws
// the same ring. Sizes in use: 14 (breadcrumb), 18 (switcher), 22–30 (column
// identity, rail), 36 (Overview).

export interface TeamRingProps {
  /** Member accents in manifest order — the ring is built from these. */
  accents: readonly string[];
  /** Pixel size of the square ring. */
  size: number;
  /** Accessible name — the team's name where known. Defaults to "Team",
   *  the same always-labelled shape `PersonalityMark` uses. */
  title?: string;
  className?: string;
}

export function TeamRing({ accents, size, title, className }: TeamRingProps) {
  const c = size / 2;
  const { r, strokeWidth } = teamRingGeometry(size);
  const arcs = teamRingArcs(accents, size);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      style={{ display: 'block', flex: 'none' }}
      role="img"
      aria-label={title ?? 'Team'}
    >
      <circle cx={c} cy={c} r={r - strokeWidth} fill="#E8E8E6" fillOpacity={0.06} />
      {arcs.map((arc) => (
        <circle
          key={arc.dashOffset}
          cx={c}
          cy={c}
          r={arc.r}
          fill="none"
          stroke={arc.color}
          strokeWidth={arc.strokeWidth}
          strokeDasharray={arc.dashArray}
          strokeDashoffset={arc.dashOffset}
          transform={`rotate(-90 ${c} ${c})`}
        />
      ))}
    </svg>
  );
}
