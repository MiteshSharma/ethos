import type { ChatMessage } from '../../lib/chat-reducer';

// One rendered message. DESIGN.md voice rules in effect:
//   • User messages: bg-overlay tint, sm radius, right-anchored.
//   • Assistant messages: bare text, left-anchored — no bubble. The
//     Linear-density pattern from DESIGN.md, not the iMessage pattern.
//
// Tool / system messages are filtered out at the reducer layer so they
// never reach this component in W2a; they reappear as inline tool chips
// in 26.W2b.

export interface MessageBubbleProps {
  message: ChatMessage;
  /** Render a streaming cursor at the end (true for the live turn). */
  streaming?: boolean;
}

export function MessageBubble({ message, streaming }: MessageBubbleProps) {
  if (message.role === 'user') {
    return (
      <div className="message-row message-row-user">
        <div className="message-user">{message.content}</div>
      </div>
    );
  }
  return (
    <div className="message-row message-row-assistant">
      <div className="message-assistant">
        {/* Preserve the LLM's whitespace — assistants ship paragraphs
            and code blocks, both of which depend on \n staying \n.
            Markdown rendering lands later; for W2a this is plain text. */}
        <span style={{ whiteSpace: 'pre-wrap' }}>{message.content}</span>
        {streaming ? <span className="streaming-cursor" aria-hidden="true" /> : null}
      </div>
    </div>
  );
}

/**
 * Specialisation for the live-streaming message — no id yet, just text.
 * Rendering a real `MessageBubble` would require fabricating an id +
 * timestamp; this skips that fiction.
 */
export function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="message-row message-row-assistant">
      <div className="message-assistant">
        <span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>
        <span className="streaming-cursor" aria-hidden="true" />
      </div>
    </div>
  );
}
