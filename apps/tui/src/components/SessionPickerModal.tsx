import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@ethosagent/types';
import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';

interface SessionPickerModalProps {
  onSelect: (session: Session) => void;
  onCancel: () => void;
}

const PAGE_SIZE = 10;

export function SessionPickerModal({ onSelect, onCancel }: SessionPickerModalProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { SQLiteSessionStore } = await import('@ethosagent/session-sqlite');
        const dbPath = join(homedir(), '.ethos', 'sessions.db');
        const store = new SQLiteSessionStore(dbPath);
        const list = await store.listSessions({ limit: 50 });
        if (!cancelled) setSessions(list);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setSelected((s) => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((s) => Math.min(sessions.length - 1, s + 1));
      return;
    }
    if (key.return && sessions[selected]) {
      onSelect(sessions[selected]);
    }
  });

  if (loading) {
    return (
      <Box>
        <Text dimColor>Loading sessions…</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">Failed to load sessions: {error}</Text>
        <Text dimColor>Press Esc to dismiss</Text>
      </Box>
    );
  }

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No saved sessions yet.</Text>
        <Text dimColor>Press Esc to dismiss</Text>
      </Box>
    );
  }

  const start = Math.max(0, Math.min(sessions.length - PAGE_SIZE, selected - 4));
  const visible = sessions.slice(start, start + PAGE_SIZE);

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text bold>Sessions ({sessions.length})</Text>
      <Box marginTop={1} flexDirection="column">
        {visible.map((s, i) => {
          const idx = start + i;
          const isSelected = idx === selected;
          const title = s.title ?? s.key;
          const tokens = s.usage.inputTokens + s.usage.outputTokens;
          return (
            <Box key={s.id} gap={1}>
              <Text color={isSelected ? 'cyan' : undefined}>{isSelected ? '▶' : ' '}</Text>
              <Text bold={isSelected} wrap="truncate">
                {title}
              </Text>
              <Text dimColor>
                · {s.platform} · {tokens.toLocaleString()} tok · $
                {s.usage.estimatedCostUsd.toFixed(4)}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑/↓ navigate · Enter resume · Esc cancel</Text>
      </Box>
    </Box>
  );
}
