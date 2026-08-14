import { personalityAccent } from '@ethosagent/design-tokens';
import { Input } from 'antd';
import { type ReactNode, useState } from 'react';
import { PersonalityRingAvatar } from '../ui/PersonalityRingAvatar';

// The chat tab's identity affordance — DESIGN.md memorable thing made
// concrete. A 3-4px accent stripe at the top edge claims the surface
// for the active personality; the mark + name + model below it tells
// you who you're talking to without you having to read the page header.
//
// Identity here is READ-ONLY: a session belongs to the personality it
// started with, so the bar shows who you are talking to and offers no way
// to change it. Talking to someone else is a new session — the picker on
// the `+` control.

export interface PersonalityBarProps {
  personalityId: string;
  /** Display name. Falls back to the id if no friendly name is provided. */
  name?: string;
  model: string;
  /** Called when the user wants to start a fresh session. Caller wipes
   *  reducer state, URL `?session=` param, and localStorage. */
  onNewSession: () => void;
  /** Current session title, if any. Undefined = no active session. */
  sessionTitle?: string | null;
  /** Called after the user confirms a new title (empty string → pass null to clear). */
  onRenameSession?: (title: string | null) => void;
  /** Opaque extra control rendered at the head of the actions cluster (e.g. the
   *  talk-mode toggle). The bar stays agnostic about what it holds. */
  actionsSlot?: ReactNode;
}

export function PersonalityBar({
  personalityId,
  name,
  model,
  onNewSession,
  sessionTitle,
  onRenameSession,
  actionsSlot,
}: PersonalityBarProps) {
  const accent = personalityAccent(personalityId);
  const displayName = name ?? capitalize(personalityId);

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  const startEdit = () => {
    setEditValue(sessionTitle ?? '');
    setEditing(true);
  };

  const commitEdit = () => {
    setEditing(false);
    if (onRenameSession) {
      onRenameSession(editValue.trim() || null);
    }
  };

  return (
    <div className="personality-bar">
      <div className="personality-bar-stripe" style={{ background: accent }} />
      <div className="personality-bar-content">
        <div className="personality-bar-left">
          <PersonalityRingAvatar personalityId={personalityId} size={28} />
          <div className="personality-bar-identity">
            <span className="personality-bar-name">{displayName}</span>
            {model ? <span className="personality-bar-model">{model}</span> : null}
          </div>
        </div>

        <div className="personality-bar-center">
          {sessionTitle !== undefined || editing ? (
            editing ? (
              <Input
                size="small"
                value={editValue}
                autoFocus
                onChange={(e) => setEditValue(e.target.value)}
                onPressEnter={commitEdit}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditing(false);
                }}
                style={{ fontSize: 13, textAlign: 'center', maxWidth: 320 }}
              />
            ) : (
              <div className="personality-bar-session-title">
                <span className="personality-bar-session-name">
                  {sessionTitle ?? 'Untitled session'}
                </span>
                {onRenameSession ? (
                  <button
                    type="button"
                    className="personality-bar-rename"
                    onClick={startEdit}
                    aria-label="Rename session"
                    title="Rename session"
                  >
                    <PencilIcon />
                  </button>
                ) : null}
              </div>
            )
          ) : null}
        </div>

        <div className="personality-bar-actions">
          {actionsSlot}
          <button
            type="button"
            className="personality-bar-new"
            onClick={onNewSession}
            aria-label="New session"
            title="New session"
          >
            <PlusIcon />
          </button>
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

function PencilIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8.5 1.5 10.5 3.5 4 10 1.5 10.5 2 8 8.5 1.5Z" />
    </svg>
  );
}

function capitalize(s: string): string {
  return s ? s[0]?.toUpperCase() + s.slice(1) : '';
}
