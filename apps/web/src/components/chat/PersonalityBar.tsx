import { personalityAccent } from '@ethosagent/web-contracts';
import { PersonalityMark } from '../ui/PersonalityMark';
import { PersonalitySwitcher } from './PersonalitySwitcher';

// The chat tab's identity affordance — DESIGN.md memorable thing made
// concrete. A 3-4px accent stripe at the top edge claims the surface
// for the active personality; the mark + name + model below it tells
// you who you're talking to without you having to read the page header.

export interface PersonalityBarProps {
  personalityId: string;
  /** Display name. Falls back to the id if no friendly name is provided. */
  name?: string;
  model: string;
  /** Called when the user picks a different personality from the
   *  switcher. Caller decides whether to fork the session. */
  onSwitchPersonality: (personalityId: string) => void;
  /** Called when the user wants to start a fresh session. Caller wipes
   *  reducer state, URL `?session=` param, and localStorage. */
  onNewSession: () => void;
}

export function PersonalityBar({
  personalityId,
  name,
  model,
  onSwitchPersonality,
  onNewSession,
}: PersonalityBarProps) {
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
        <div className="personality-bar-actions">
          <button
            type="button"
            className="personality-bar-new"
            onClick={onNewSession}
            aria-label="New session"
            title="New session"
          >
            <PlusIcon />
          </button>
          <PersonalitySwitcher current={personalityId} onSelect={onSwitchPersonality} />
        </div>
      </div>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M7 2.5v9M2.5 7h9" />
    </svg>
  );
}

function capitalize(s: string): string {
  return s ? s[0]?.toUpperCase() + s.slice(1) : '';
}
