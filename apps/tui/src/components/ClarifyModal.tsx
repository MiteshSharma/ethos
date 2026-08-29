// ClarifyModal — the agent asked a structured question mid-turn (the `clarify`
// tool). Opens over the App; ↑/↓ + Enter pick an option, free-form questions
// take typed text, Esc cancels. A live countdown shows when the default fires.

import type { PendingClarify } from '@ethosagent/types';
import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';

interface ClarifyModalProps {
  request: PendingClarify;
  onAnswer: (answer: string) => void;
  onCancel: () => void;
}

// `deadlineAt` is `null` while a clarify is still queued behind another one
// in the same lane (D2) — no timer has started yet.
function formatCountdown(deadlineAt: string | null, now: number): string {
  if (deadlineAt === null) return 'queued';
  const ms = new Date(deadlineAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

export function ClarifyModal({ request, onAnswer, onCancel }: ClarifyModalProps) {
  const options = request.options ?? [];
  const hasOptions = options.length > 0;
  const [selected, setSelected] = useState(0);
  const [text, setText] = useState('');
  const [now, setNow] = useState(() => Date.now());

  // Live countdown — refresh once a second.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (hasOptions) {
      if (key.upArrow) {
        setSelected((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setSelected((s) => Math.min(options.length - 1, s + 1));
        return;
      }
      if (key.return) {
        const choice = options[selected];
        if (choice !== undefined) onAnswer(choice);
        return;
      }
      return;
    }
    // Free-form text input.
    if (key.return) {
      if (text.trim()) onAnswer(text.trim());
      return;
    }
    if (key.backspace || key.delete) {
      setText((t) => t.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setText((t) => t + input);
    }
  });

  const countdown = formatCountdown(request.defaultDeadlineAt, now);
  const defaultHint =
    request.default !== undefined
      ? `default \`${request.default}\` in ${countdown}`
      : `times out in ${countdown}`;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color="yellow">
        ? {request.question}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {hasOptions ? (
          options.map((opt, idx) => {
            const isSelected = idx === selected;
            return (
              <Box key={opt} gap={1} paddingLeft={1}>
                <Text color={isSelected ? 'cyan' : undefined}>{isSelected ? '▶' : ' '}</Text>
                <Text bold={isSelected}>
                  {idx + 1}. {opt}
                </Text>
              </Box>
            );
          })
        ) : (
          <Box paddingLeft={1}>
            <Text>{text || ' '}</Text>
            <Text inverse> </Text>
          </Box>
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {hasOptions ? '↑/↓ navigate · Enter select' : 'type your answer · Enter submit'} · Esc
          cancel · {defaultHint}
        </Text>
      </Box>
    </Box>
  );
}
