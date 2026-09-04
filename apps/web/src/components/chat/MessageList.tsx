import { useEffect, useRef, useState } from 'react';
import { useFenceResolver } from '../../features/renderers/resolver';
import type { AssistantTurn, ChatMessage } from '../../lib/chat-reducer';
import type { TrailState } from '../../lib/trail';
import { SaveToDashboardContextMenu } from '../dashboard/SaveToDashboardContextMenu';
import { SaveToDashboardModal } from '../dashboard/SaveToDashboardModal';
import { AssistantBubble, UserBubble } from './MessageBubble';
import type { RunSurface } from './RunCard';

// Scrollable history. Auto-scrolls to the bottom as content arrives —
// but only when the user was already pinned to the bottom, so reading
// older messages doesn't get yanked back down by every text_delta.

export interface MessageListProps {
  messages: ChatMessage[];
  /** In-flight assistant turn rendered at the tail of the list. */
  currentTurn: AssistantTurn | null;
  personalityId?: string;
  model?: string;
  sessionId?: string;
  /** Puts a suggested prompt in the composer (`recommend_actions` pills). */
  onSuggestPrompt?: (prompt: string) => void;
  /** Starts talk-mode from the empty state. Absent = no "Try voice" pill. */
  onTryVoice?: () => void;
  /** Live delegated-run state for the transcript's run anchors (§4.1). */
  runSurface?: RunSurface;
  /** Per-turn activity trails — the footer under each bubble (contract §3). */
  trail?: TrailState;
  /** Turns the user stopped; their footer reads `✗ stopped`. */
  stoppedTurnIds?: string[];
}

export function MessageList({
  messages,
  currentTurn,
  personalityId,
  model,
  sessionId,
  onSuggestPrompt,
  onTryVoice,
  runSurface,
  trail,
  stoppedTurnIds,
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveModalUserMessage, setSaveModalUserMessage] = useState<string | undefined>();
  const [showScrollDown, setShowScrollDown] = useState(false);
  // One resolver for the whole list, derived from the personality actually
  // being rendered with. History re-decides live on a personality switch —
  // nothing is stamped onto a message.
  const fenceRenderers = useFenceResolver(personalityId ?? '');

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottomRef.current = fromBottom < 32;
    setShowScrollDown(fromBottom >= 100);
  };

  const scrollToBottom = () => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  // Re-run on every visible change. The `currentTurn` reference is the
  // signal — its blocks update on every text_delta / tool_start /
  // tool_end. messages.length flips on done.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps trigger the effect intentionally — re-run on every new chunk so the scroll catches up
  useEffect(() => {
    if (!pinnedToBottomRef.current) return;
    const el = listRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [messages.length, currentTurn]);

  if (messages.length === 0 && !currentTurn) {
    return (
      <EmptyState
        personalityId={personalityId}
        model={model}
        onSuggestPrompt={onSuggestPrompt}
        {...(onTryVoice ? { onTryVoice } : {})}
      />
    );
  }

  // Derived "thinking" state: the user just sent a message, no SSE event
  // has arrived yet (currentTurn null), and there's no error. Shows a
  // pulsing placeholder bubble so the user sees the agent is alive even
  // before the first text_delta lands. The first event clears it (because
  // currentTurn becomes non-null and the live streaming bubble takes over).
  const lastMessage = messages[messages.length - 1];
  const isThinking = lastMessage?.role === 'user' && !currentTurn;

  const openSaveModal = (msgIndex: number) => {
    // Walk backwards to find the preceding user message for this assistant turn.
    let userMsg: string | undefined;
    for (let i = msgIndex - 1; i >= 0; i--) {
      const prev = messages[i];
      if (prev?.role === 'user') {
        userMsg = prev.content;
        break;
      }
    }
    setSaveModalUserMessage(userMsg);
    setSaveModalOpen(true);
  };

  return (
    <div ref={listRef} className="message-list" onScroll={onScroll}>
      {messages.map((m, idx) =>
        m.role === 'user' ? (
          <UserBubble key={m.id} message={m} />
        ) : (
          <SaveToDashboardContextMenu key={m.id} onSaveToDashboard={() => openSaveModal(idx)}>
            <AssistantBubble
              turn={m}
              fenceRenderers={fenceRenderers}
              onSuggestPrompt={onSuggestPrompt}
              {...(personalityId ? { personalityId } : {})}
              {...(runSurface ? { runSurface } : {})}
              {...(trail?.[m.id] ? { trail: trail[m.id] } : {})}
              {...(stoppedTurnIds?.includes(m.id) ? { stopped: true } : {})}
            />
          </SaveToDashboardContextMenu>
        ),
      )}
      {currentTurn ? (
        <AssistantBubble
          turn={currentTurn}
          streaming
          fenceRenderers={fenceRenderers}
          onSuggestPrompt={onSuggestPrompt}
          {...(personalityId ? { personalityId } : {})}
          {...(runSurface ? { runSurface } : {})}
          {...(trail?.[currentTurn.id] ? { trail: trail[currentTurn.id] } : {})}
          {...(stoppedTurnIds?.includes(currentTurn.id) ? { stopped: true } : {})}
        />
      ) : null}
      {isThinking ? <ThinkingBubble /> : null}
      <SaveToDashboardModal
        open={saveModalOpen}
        onClose={() => setSaveModalOpen(false)}
        userMessage={saveModalUserMessage}
        sessionId={sessionId}
      />
      {showScrollDown && (
        <button
          type="button"
          className="scroll-to-bottom-btn"
          onClick={scrollToBottom}
          aria-label="Scroll to latest message"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M8 3v10M4 9l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

function ThinkingBubble() {
  return (
    <div className="message-row message-row-assistant">
      <div
        role="status"
        className="message-assistant message-thinking"
        aria-label="Agent is thinking"
      >
        <span className="thinking-dot" />
        <span className="thinking-dot" />
        <span className="thinking-dot" />
      </div>
    </div>
  );
}

const DEFAULT_PILLS = [
  'Explore a topic',
  'Explain this file',
  'Search memory',
  'Run a skill',
] as const;

function EmptyState({
  personalityId,
  model,
  onSuggestPrompt,
  onTryVoice,
}: {
  personalityId?: string;
  model?: string;
  onSuggestPrompt?: (prompt: string) => void;
  onTryVoice?: () => void;
}) {
  return (
    <div className="message-list-empty">
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: 'rgba(74,158,255,0.08)',
          border: '1px solid rgba(74,158,255,0.15)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg aria-hidden="true" width="32" height="32" viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="7" fill="#4A9EFF" />
          <circle cx="8" cy="8" r="3" fill="var(--bg-base, #0F0F0F)" />
        </svg>
      </div>
      <div className="empty-state-brand">Ethos</div>
      {personalityId ? <div className="empty-state-name">{personalityId}</div> : null}
      {model ? <div className="empty-state-model">{model}</div> : null}
      <div className="empty-state-tagline">Ready to help.</div>
      <div className="empty-state-pills">
        {DEFAULT_PILLS.map((p) => (
          <button
            key={p}
            type="button"
            className="empty-state-pill"
            onClick={() => onSuggestPrompt?.(p)}
          >
            {p}
          </button>
        ))}
        {/* The one pill that does not pre-fill the composer — it starts a call
            (DR2 first-conversation moment). Rendered only where talk-mode is
            actually available, so it is never a dead end. */}
        {onTryVoice ? (
          <button type="button" className="empty-state-pill" onClick={onTryVoice}>
            Try voice
          </button>
        ) : null}
      </div>
    </div>
  );
}
