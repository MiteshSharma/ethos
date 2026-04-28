import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../../lib/chat-reducer';
import { MessageBubble, StreamingBubble } from './MessageBubble';

// Scrollable history. Auto-scrolls to the bottom as content arrives —
// but only when the user was already pinned to the bottom, so reading
// older messages doesn't get yanked back down by every text_delta.
//
// Empty state for a fresh chat: a single line that doubles as a
// magic-moment hint without being marketing copy.

export interface MessageListProps {
  messages: ChatMessage[];
  streamingText: string | null;
  emptyHint?: string;
}

export function MessageList({ messages, streamingText, emptyHint }: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);

  // Track whether the user is currently at the bottom of the scroll
  // viewport. If they've scrolled up to read history, don't auto-scroll
  // when new chunks arrive — reading is more important than animation.
  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottomRef.current = fromBottom < 32;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps trigger the effect intentionally — re-run on every new chunk so the scroll catches up
  useEffect(() => {
    if (!pinnedToBottomRef.current) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, streamingText]);

  if (messages.length === 0 && !streamingText) {
    return (
      <div className="message-list-empty">
        <span>{emptyHint ?? 'Start the conversation. Tools, files, and skills come along.'}</span>
      </div>
    );
  }

  return (
    <div ref={listRef} className="message-list" onScroll={onScroll}>
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}
      {streamingText !== null ? <StreamingBubble text={streamingText} /> : null}
    </div>
  );
}
