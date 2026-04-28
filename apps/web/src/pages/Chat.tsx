import { App as AntApp, ConfigProvider } from 'antd';
import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApprovalModal } from '../components/chat/ApprovalModal';
import { Composer } from '../components/chat/Composer';
import { MessageList } from '../components/chat/MessageList';
import { PersonalityBar } from '../components/chat/PersonalityBar';
import { useActivePersonality } from '../hooks/useActivePersonality';
import { useChat } from '../hooks/useChat';
import { clearLastSessionId, getLastSessionId, setLastSessionId } from '../lib/lastSession';
import { personalityTheme } from '../lib/theme';
import { rpc } from '../rpc';

// The chat surface — daily-driver tab in v0. Composition:
//
//   ┌────────────────────────────────┐
//   │  PersonalityBar (accent stripe)│
//   ├────────────────────────────────┤
//   │  MessageList (scrollable)      │
//   │  ↳ ghost streaming bubble at   │
//   │    the tail while in-flight    │
//   ├────────────────────────────────┤
//   │  [error banner if present]     │
//   │  Composer (sticky bottom)      │
//   └────────────────────────────────┘
//
// The whole subtree is wrapped in a per-personality `<ConfigProvider>`
// so Antd primitives inherit the active accent (Send button background,
// caret, focus ring, link colors). The base theme + AntApp wrap higher
// up in `main.tsx`.
//
// `?session=<id>` in the URL is the deep-link handle — opening a session
// from the Sessions tab (W4) navigates here with the param set; sending
// a fresh message updates the URL to the server-assigned id so refresh
// stays on the same conversation.

export function Chat() {
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionParam = searchParams.get('session') ?? undefined;
  const { id: personalityId, model, isLoading, setOverride } = useActivePersonality();
  const { notification } = AntApp.useApp();

  // Restore last session on first mount when no `?session=` is in the URL.
  // Lives at the page level (not inside useChat) because it interacts with
  // routing — restoring means navigating, which is a Chat-page concern.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately mount-only — once we know there's no URL param we look up storage exactly once
  useEffect(() => {
    if (sessionParam) return;
    const stored = getLastSessionId();
    if (stored) setSearchParams({ session: stored }, { replace: true });
  }, []);

  const { state, currentSessionId, sendMessage, switchSession, resetSession } = useChat({
    ...(sessionParam ? { initialSessionId: sessionParam } : {}),
    personalityId,
    onSessionCreated: (id) => {
      // Mirror the server-assigned id into the URL so refresh stays on
      // this conversation. `replace` (not `push`) keeps Back from
      // bouncing the user out of an empty chat.
      setSearchParams({ session: id }, { replace: true });
      setLastSessionId(id);
    },
  });

  // Mirror every URL session change into localStorage so a refresh after
  // landing here from the Sessions tab (or a deep-link paste) sticks.
  useEffect(() => {
    if (sessionParam) setLastSessionId(sessionParam);
  }, [sessionParam]);

  // Render the head of the queue. Multiple back-to-back approvals are
  // rare in practice (the agent loop awaits each tool sequentially), but
  // the queue model means we don't have to special-case "second approval
  // arrived while the first modal was open."
  const pendingApproval = state.pendingApprovals[0];

  const handleSwitchPersonality = async (newId: string) => {
    // No-op: same personality clicked.
    if (newId === personalityId) return;

    // Empty session — no fork needed; the next chat.send creates a fresh
    // session under the new personality.
    if (!currentSessionId || state.messages.length === 0) {
      setOverride(newId);
      return;
    }

    // Active conversation — auto-fork per DESIGN.md to avoid tool-history
    // mismatch when the new personality's toolset doesn't cover the prior
    // calls. Old session stays available in Sessions tab; fork starts
    // clean (well, with the same history copied) under the new accent.
    try {
      const result = await rpc.sessions.fork({ id: currentSessionId, personalityId: newId });
      switchSession(result.session.id);
      setSearchParams({ session: result.session.id }, { replace: true });
      setLastSessionId(result.session.id);
      setOverride(newId);
      notification.info({
        message: `Forked to ${capitalize(newId)}`,
        description: 'Previous conversation is in the Sessions tab.',
        placement: 'topRight',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notification.error({
        message: 'Could not fork session',
        description: message,
        placement: 'topRight',
      });
    }
  };

  const handleNewSession = () => {
    // Wipe everything tying us to the current conversation: URL,
    // reducer state, localStorage. The next chat.send creates a fresh
    // session on the server and we re-record its id everywhere.
    setSearchParams({}, { replace: true });
    clearLastSessionId();
    resetSession();
  };

  return (
    <ConfigProvider theme={personalityTheme(personalityId)}>
      <div className="chat-tab">
        <PersonalityBar
          personalityId={personalityId}
          model={isLoading ? '' : model}
          onSwitchPersonality={(id) => void handleSwitchPersonality(id)}
          onNewSession={handleNewSession}
        />
        {pendingApproval ? (
          <ApprovalModal key={pendingApproval.approvalId} request={pendingApproval} />
        ) : null}
        <MessageList
          messages={state.messages}
          currentTurn={state.currentTurn}
          emptyHint={
            currentSessionId
              ? 'No messages in this session yet. Send one to get started.'
              : 'Start the conversation. Tools, files, and skills come along.'
          }
        />
        <div>
          {state.error ? (
            <div className="chat-error" role="alert">
              {state.error}
            </div>
          ) : null}
          <Composer
            personalityId={personalityId}
            disabled={state.isStreaming}
            onSend={sendMessage}
            placeholder={state.isStreaming ? 'Waiting for the response…' : 'Send a message…'}
          />
        </div>
      </div>
    </ConfigProvider>
  );
}

function capitalize(s: string): string {
  return s ? s[0]?.toUpperCase() + s.slice(1) : '';
}
