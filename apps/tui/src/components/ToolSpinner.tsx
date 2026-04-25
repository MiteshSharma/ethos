import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return <Text color="cyan">{FRAMES[frame]}</Text>;
}

export interface ActiveTool {
  toolCallId: string;
  toolName: string;
}

export interface CompletedTool {
  id: string;
  toolName: string;
  ok: boolean;
  durationMs: number;
}

interface ToolSpinnerProps {
  activeTools: ActiveTool[];
  completedTools: CompletedTool[];
}

export function ToolSpinner({ activeTools, completedTools }: ToolSpinnerProps) {
  if (activeTools.length === 0 && completedTools.length === 0) return null;
  return (
    <Box flexDirection="column">
      {completedTools.map((t) => (
        <Box key={t.id} gap={1}>
          <Text color={t.ok ? 'green' : 'red'}>{t.ok ? '✓' : '✗'}</Text>
          <Text dimColor>
            {t.toolName} {t.durationMs}ms
          </Text>
        </Box>
      ))}
      {activeTools.map((t) => (
        <Box key={t.toolCallId} gap={1}>
          <Spinner />
          <Text dimColor>{t.toolName}</Text>
        </Box>
      ))}
    </Box>
  );
}
