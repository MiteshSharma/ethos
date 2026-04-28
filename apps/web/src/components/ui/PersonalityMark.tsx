import { generatePersonalityMark, personalityAccent } from '@ethosagent/web-contracts';

// SVG renderer for the deterministic personality mark. The algorithm
// lives in `@ethosagent/web-contracts/marks` so the same mark renders
// identically on every surface — web, future TUI ASCII, OG-image gen.
//
// This component is the entry point for "the agent team is present" —
// 26.W2 (chat personality bar) and 26.W3 (onboarding picker rows) both
// consume it. A single source of geometry means the personality you
// recognize in onboarding is exactly the one you see at the top of chat.

export interface PersonalityMarkProps {
  /** Personality id — drives both the mark geometry and (default) accent. */
  personalityId: string;
  /** Pixel size of the square mark. Default 40 (chat personality bar). */
  size?: number;
  /**
   * Override the accent. Useful when a future custom-personality flow
   * lets users pick their own color — the stored hex flows in here
   * without changing the spec.
   */
  accent?: string;
  /** Accessible label. Default `"<id> personality"`. */
  label?: string;
}

export function PersonalityMark({ personalityId, size = 40, accent, label }: PersonalityMarkProps) {
  const spec = generatePersonalityMark(personalityId);
  const color = accent ?? personalityAccent(personalityId);
  const cellSize = size / 5;
  const accessibleLabel = label ?? `${personalityId} personality`;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={accessibleLabel}
      style={{ flexShrink: 0, display: 'block' }}
    >
      <rect
        x={0}
        y={0}
        width={size}
        height={size}
        rx={size * spec.bgRadius}
        fill={color}
        fillOpacity={spec.bgAlpha}
      />
      {spec.cells.map(({ row, col, opacity }) => (
        <rect
          // row+col is unique per cell (mirror partners differ in col),
          // so the composite key stays stable across renders.
          key={`${row}-${col}`}
          x={col * cellSize}
          y={row * cellSize}
          width={cellSize}
          height={cellSize}
          fill={color}
          fillOpacity={opacity}
        />
      ))}
    </svg>
  );
}
