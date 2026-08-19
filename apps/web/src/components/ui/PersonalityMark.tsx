import { personalityAccent } from '@ethosagent/design-tokens';
import { generatePersonalityMark } from '@ethosagent/web-contracts';
import { useId, useState } from 'react';

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
  /** Custom avatar image URL (`display.avatar_url`). When present, renders
   *  in place of the generated grid mark, sized/clipped identically (same
   *  circular footprint). On load failure (broken link, deleted file, 404)
   *  falls back to the generated mark exactly as if `avatarUrl` were absent. */
  avatarUrl?: string;
}

export function PersonalityMark({
  personalityId,
  size = 40,
  accent,
  label,
  avatarUrl,
}: PersonalityMarkProps) {
  const [imageErrored, setImageErrored] = useState(false);
  const spec = generatePersonalityMark(personalityId);
  const color = accent ?? personalityAccent(personalityId);
  const cellSize = size / 5;
  const accessibleLabel = label ?? `${personalityId} personality`;
  // Unique per instance — this component renders multiple times
  // simultaneously for the same personality (e.g. AltitudeRail + ScopeNav),
  // and an id derived only from personalityId would collide across those
  // instances, breaking the clip-path url(#...) reference in some browsers.
  const clipId = `mark-clip-${useId()}`;
  const center = size / 2;
  const strokeWidth = Math.max(1, size * 0.04);
  const ringRadius = center - strokeWidth / 2;

  const showAvatar = Boolean(avatarUrl) && !imageErrored;

  if (showAvatar) {
    return (
      <img
        src={avatarUrl}
        alt=""
        aria-label={accessibleLabel}
        width={size}
        height={size}
        style={{
          flexShrink: 0,
          display: 'block',
          width: size,
          height: size,
          borderRadius: '50%',
          objectFit: 'cover',
        }}
        onError={() => setImageErrored(true)}
      />
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={accessibleLabel}
      style={{ flexShrink: 0, display: 'block' }}
    >
      <defs>
        <clipPath id={clipId}>
          <circle cx={center} cy={center} r={center} />
        </clipPath>
      </defs>
      <circle cx={center} cy={center} r={center} fill={color} fillOpacity={spec.bgAlpha} />
      <circle
        cx={center}
        cy={center}
        r={ringRadius}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeOpacity={spec.ringAlpha}
      />
      <g clipPath={`url(#${clipId})`}>
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
      </g>
    </svg>
  );
}
