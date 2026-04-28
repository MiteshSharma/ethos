import { personalityAccent } from '@ethosagent/web-contracts';
import { PersonalityMark } from '../ui/PersonalityMark';

// The chat tab's identity affordance — DESIGN.md memorable thing made
// concrete. A 3-4px accent stripe at the top edge claims the surface
// for the active personality; the mark + name + model below it tells
// you who you're talking to without you having to read the page header.
//
// Layout intentionally sparse: name in display weight, model in mono
// (Geist Mono per the typography spec — model names are data, not UI
// chrome). The right slot is reserved for the switcher dropdown that
// lands in 26.W2d; for now it renders nothing and the personality is
// fixed for the session.

export interface PersonalityBarProps {
  personalityId: string;
  /** Display name. Falls back to the id if no friendly name is provided. */
  name?: string;
  model: string;
}

export function PersonalityBar({ personalityId, name, model }: PersonalityBarProps) {
  const accent = personalityAccent(personalityId);
  const displayName = name ?? capitalize(personalityId);

  return (
    <div className="personality-bar">
      <div className="personality-bar-stripe" style={{ background: accent }} />
      <div className="personality-bar-content">
        <PersonalityMark personalityId={personalityId} size={32} />
        <div className="personality-bar-text">
          <span className="personality-bar-name">{displayName}</span>
          {model ? <span className="personality-bar-model">{model}</span> : null}
        </div>
        {/* Switcher slot — wired in 26.W2d. */}
        <div className="personality-bar-actions" />
      </div>
    </div>
  );
}

function capitalize(s: string): string {
  return s ? s[0]?.toUpperCase() + s.slice(1) : '';
}
