import { personalityAccent } from '@ethosagent/design-tokens';
import { Input } from 'antd';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { buildWorkspaceChatPath } from '../../lib/workspaceRoutes';
import { PersonalityMark } from '../ui/PersonalityMark';
import { PersonalityRingAvatar } from '../ui/PersonalityRingAvatar';
import { TeamRing } from '../ui/TeamRing';

// The chat tab's identity affordance — DESIGN.md memorable thing made
// concrete. A 3-4px accent stripe at the top edge claims the surface
// for the active personality; the mark + name + model below it tells
// you who you're talking to without you having to read the page header.
//
// Identity here is READ-ONLY: a session belongs to the personality it
// started with, so the bar shows who you are talking to and offers no way
// to change it. Talking to someone else is a new session — the picker on
// the `+` control.
//
// Two team-shaped variants (plan/phases/teams-as-a-scope.md D4, §8 "Chat"),
// both still read-only identity:
//   • `teamContext` — the team Chat pane. The bar reads
//     `<ring> <team> = <mark> <coordinator> · coordinator · <model>` with an
//     `Open <coordinator>'s workspace →` link, because the team's chat IS the
//     coordinator's session and the bar should say so.
//   • `coordinatorOf` — the coordinator's own workspace inside its team. The
//     reverse label after the model: `coordinator of <team> · this is the
//     team's chat`. One session list, two doors.

export interface PersonalityBarTeamContext {
  teamId: string;
  teamName: string;
  /** Member accents in manifest order — what the ring is built from. */
  accents: string[];
  coordinatorId: string;
  /** The coordinator's display name — the bar never shows the id. */
  coordinatorName: string;
}

export interface PersonalityBarCoordinatorOf {
  teamId: string;
  teamName: string;
  accents: string[];
}

export interface PersonalityBarProps {
  personalityId: string;
  /** Display name. Falls back to the id if no friendly name is provided. */
  name?: string;
  /** Custom avatar image URL (`display.avatar_url`). Falls back to the
   *  generated ring mark when absent or on load failure. */
  avatarUrl?: string;
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
  /** The team Chat pane variant — `personalityId` is the coordinator. */
  teamContext?: PersonalityBarTeamContext;
  /** The coordinator's own workspace inside its team — the reverse label. */
  coordinatorOf?: PersonalityBarCoordinatorOf;
}

export function PersonalityBar({
  personalityId,
  name,
  avatarUrl,
  model,
  onNewSession,
  sessionTitle,
  onRenameSession,
  actionsSlot,
  teamContext,
  coordinatorOf,
}: PersonalityBarProps) {
  const accent = personalityAccent(personalityId);
  const displayName = teamContext?.coordinatorName ?? name ?? capitalize(personalityId);

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
        {teamContext ? (
          <div className="personality-bar-left team-chat-bar-left">
            <TeamRing accents={teamContext.accents} size={22} title={teamContext.teamName} />
            <span className="team-chat-bar-team">{teamContext.teamName}</span>
            <span className="team-chat-bar-eq">
              <span aria-hidden="true">=</span>
              <PersonalityMark personalityId={personalityId} size={18} avatarUrl={avatarUrl} />
              <span className="team-chat-bar-coordinator">{displayName}</span>
              <span className="team-chat-bar-role">coordinator{model ? ` · ${model}` : ''}</span>
            </span>
          </div>
        ) : (
          <div className="personality-bar-left">
            <PersonalityRingAvatar personalityId={personalityId} size={28} avatarUrl={avatarUrl} />
            <div className="personality-bar-identity">
              <span className="personality-bar-name">{displayName}</span>
              {model ? <span className="personality-bar-model">{model}</span> : null}
            </div>
            {coordinatorOf ? (
              <span className="team-chat-bar-coordinator-of">
                <TeamRing
                  accents={coordinatorOf.accents}
                  size={14}
                  title={coordinatorOf.teamName}
                />
                <span>coordinator of {coordinatorOf.teamName} · this is the team's chat</span>
              </span>
            ) : null}
          </div>
        )}

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
          {teamContext ? (
            <Link
              className="team-chat-bar-link"
              to={buildWorkspaceChatPath(personalityId, teamContext.teamId)}
            >
              Open {displayName}'s workspace →
            </Link>
          ) : null}
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
