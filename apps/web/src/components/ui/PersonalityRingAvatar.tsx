import { personalityAccent } from '@ethosagent/design-tokens';
import { useState } from 'react';

interface PersonalityRingAvatarProps {
  personalityId: string;
  name?: string;
  size?: number;
  /** Custom avatar image URL (`display.avatar_url`). When present, renders
   *  in place of the generated ring+dot mark, sized/clipped identically. On
   *  load failure (broken link, deleted file, 404) falls back to the
   *  generated mark exactly as if `avatarUrl` were absent. */
  avatarUrl?: string;
}

export function PersonalityRingAvatar({
  personalityId,
  size = 32,
  avatarUrl,
}: PersonalityRingAvatarProps) {
  const [imageErrored, setImageErrored] = useState(false);
  const color = personalityAccent(personalityId);
  const borderWidth = 3;
  const svgSize = Math.round(size * 0.44);
  const outerR = 5;
  const innerR = 2;

  const showAvatar = Boolean(avatarUrl) && !imageErrored;

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        border: `${borderWidth}px solid ${color}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        background: 'var(--bg-base)',
        overflow: 'hidden',
      }}
    >
      {showAvatar ? (
        <img
          src={avatarUrl}
          alt=""
          width={size}
          height={size}
          style={{ width: size, height: size, objectFit: 'cover', borderRadius: '50%' }}
          onError={() => setImageErrored(true)}
        />
      ) : (
        <svg width={svgSize} height={svgSize} viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r={outerR} fill="none" stroke={color} strokeWidth="2.5" />
          <circle cx="8" cy="8" r={innerR} fill={color} />
        </svg>
      )}
    </div>
  );
}
