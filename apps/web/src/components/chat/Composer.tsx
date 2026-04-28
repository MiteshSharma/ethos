import { personalityAccent } from '@ethosagent/web-contracts';
import { Button, Input } from 'antd';
import { type KeyboardEvent, useState } from 'react';

// Sticky composer at the bottom of the chat surface. Three keyboard
// rules, all standard chat UX:
//   • Enter      → send (preventDefault — no newline).
//   • Shift+Enter → newline.
//   • Cmd/Ctrl+Enter → also send (the user-was-using-newlines path).
//
// The accent caret is the subtlest personality fingerprint in the
// product — `caret-color: var(--accent)` flows from the per-personality
// ConfigProvider wrapper above this component. People notice it without
// being able to say why.

export interface ComposerProps {
  personalityId: string;
  /** Disable the input + button while a turn is in flight. */
  disabled?: boolean;
  onSend: (text: string) => void | Promise<void>;
  /** Optional placeholder. Default mirrors the magic-moment prompt for
   *  empty sessions; pages override for already-active sessions. */
  placeholder?: string;
}

export function Composer({ personalityId, disabled, onSend, placeholder }: ComposerProps) {
  const [text, setText] = useState('');
  const accent = personalityAccent(personalityId);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    setText('');
    void onSend(trimmed);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') return;
    if (e.shiftKey) return; // newline — let the textarea handle it
    e.preventDefault();
    handleSend();
  };

  return (
    <div className="composer">
      <Input.TextArea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? 'Send a message…'}
        autoSize={{ minRows: 1, maxRows: 8 }}
        // The accent caret is the load-bearing detail. Inline style is
        // the only way Antd's TextArea exposes it.
        style={{ caretColor: accent, fontSize: 14, lineHeight: 1.5 }}
        disabled={disabled}
      />
      <Button
        type="primary"
        onClick={handleSend}
        disabled={disabled || text.trim() === ''}
        // Antd's `colorPrimary` token already carries the accent thanks
        // to the per-personality ConfigProvider wrapper. No override here.
      >
        Send
      </Button>
    </div>
  );
}
