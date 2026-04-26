import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { useSkin } from '../skin';

interface InputBoxProps {
  value: string;
  disabled?: boolean;
  isActive?: boolean;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onTabComplete?: () => void;
  onArrowUp?: () => void;
  onArrowDown?: () => void;
  onEscape?: () => void;
}

const PASTE_THRESHOLD = 200;

function renderWithCursor(value: string, cursor: number): React.ReactNode {
  if (cursor >= value.length) {
    return (
      <Text>
        {value}
        <Text inverse> </Text>
      </Text>
    );
  }
  return (
    <Text>
      {value.slice(0, cursor)}
      <Text inverse>{value[cursor]}</Text>
      {value.slice(cursor + 1)}
    </Text>
  );
}

export function InputBox({
  value,
  disabled,
  isActive = true,
  onChange,
  onSubmit,
  onTabComplete,
  onArrowUp,
  onArrowDown,
  onEscape,
}: InputBoxProps) {
  const skin = useSkin();
  const [cursor, setCursor] = useState(value.length);
  const safeCursor = Math.min(cursor, value.length);

  const replace = (next: string, nextCursor: number) => {
    onChange(next);
    setCursor(Math.max(0, Math.min(next.length, nextCursor)));
  };

  useInput(
    (input, key) => {
      if (disabled) return;

      // Escape
      if (key.escape) {
        onEscape?.();
        return;
      }

      // Submit (Enter without modifiers)
      if (key.return && !key.shift) {
        const trimmed = value.trim();
        if (trimmed) {
          onSubmit(trimmed);
          setCursor(0);
        }
        return;
      }

      // Shift+Enter inserts a newline at cursor
      if (key.return && key.shift) {
        replace(value.slice(0, safeCursor) + '\n' + value.slice(safeCursor), safeCursor + 1);
        return;
      }

      // Tab: completion delegated to parent
      if (key.tab) {
        onTabComplete?.();
        return;
      }

      // Arrow up/down delegated to parent (for completion navigation)
      if (key.upArrow) {
        onArrowUp?.();
        return;
      }
      if (key.downArrow) {
        onArrowDown?.();
        return;
      }

      // Cursor navigation
      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(value.length, c + 1));
        return;
      }

      // Backspace: delete char before cursor.
      // Note: Ink v5 reports the macOS Backspace key (0x7f) as key.delete,
      // and reserves key.backspace for Ctrl+H (0x08). Both should erase the
      // previous character — there's no separate forward-delete in Ink yet.
      if (key.backspace || key.delete) {
        if (safeCursor === 0) return;
        replace(value.slice(0, safeCursor - 1) + value.slice(safeCursor), safeCursor - 1);
        return;
      }

      // Ctrl+A — beginning of line
      if (key.ctrl && input === 'a') {
        setCursor(0);
        return;
      }

      // Ctrl+E — end of line
      if (key.ctrl && input === 'e') {
        setCursor(value.length);
        return;
      }

      // Ctrl+U — clear line
      if (key.ctrl && input === 'u') {
        replace('', 0);
        return;
      }

      // Ctrl+K — kill from cursor to end
      if (key.ctrl && input === 'k') {
        replace(value.slice(0, safeCursor), safeCursor);
        return;
      }

      // Ctrl+W — delete word backwards
      if (key.ctrl && input === 'w') {
        const left = value.slice(0, safeCursor);
        const trimmed = left.replace(/\S+\s*$/, '');
        replace(trimmed + value.slice(safeCursor), trimmed.length);
        return;
      }

      // Skip remaining ctrl/meta sequences
      if (key.ctrl || key.meta) return;

      // Insert input at cursor. Multi-char input = paste.
      if (input) {
        replace(
          value.slice(0, safeCursor) + input + value.slice(safeCursor),
          safeCursor + input.length,
        );
      }
    },
    { isActive: isActive && !disabled },
  );

  // Display: collapse very long pastes inline.
  const showCollapsed = value.length > PASTE_THRESHOLD;
  const lines = value.split('\n');
  const lineCount = lines.length;

  return (
    <Box borderStyle={skin.borderStyle} paddingX={1} flexDirection="column">
      <Box>
        <Text color={skin.promptColor} bold>
          You
        </Text>
        <Text dimColor> {skin.promptGlyph} </Text>
        {value === '' ? (
          <Text>
            <Text inverse> </Text>
            <Text dimColor>{disabled ? 'waiting…' : 'Type a message or /help…'}</Text>
          </Text>
        ) : showCollapsed ? (
          <Text dimColor>
            [pasted {lineCount} lines / {value.length} chars — Enter to send]
          </Text>
        ) : (
          renderWithCursor(value, safeCursor)
        )}
      </Box>
      {!showCollapsed && lineCount > 1 && (
        <Box>
          <Text dimColor>{lineCount} lines · Shift+Enter for newline · Enter to send</Text>
        </Box>
      )}
    </Box>
  );
}
