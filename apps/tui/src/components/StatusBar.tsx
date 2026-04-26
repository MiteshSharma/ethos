import { Box, Text } from 'ink';
import { useSkin } from '../skin';

export type AgentStatus = 'idle' | 'thinking' | 'running' | 'interrupted';

interface StatusBarProps {
  model: string;
  personality: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  status: AgentStatus;
  currentTool?: string;
}

function StatusIndicator({ status, currentTool }: { status: AgentStatus; currentTool?: string }) {
  switch (status) {
    case 'thinking':
      return <Text color="yellow"> thinking…</Text>;
    case 'running':
      return (
        <Text color="cyan">
          {' running'}
          {currentTool ? `: ${currentTool}` : ''}
          {'…'}
        </Text>
      );
    case 'interrupted':
      return <Text color="red"> interrupted</Text>;
    default:
      return null;
  }
}

export function StatusBar({
  model,
  personality,
  inputTokens,
  outputTokens,
  costUsd,
  status,
  currentTool,
}: StatusBarProps) {
  const skin = useSkin();
  return (
    <Box marginBottom={1}>
      <Text bold color={skin.bannerColor}>
        ethos
      </Text>
      <Text color={skin.modelColor}>
        {' '}
        {model} · {personality}
      </Text>
      <StatusIndicator status={status} currentTool={currentTool} />
      <Text color={skin.modelColor}>
        {'  '}
        {inputTokens.toLocaleString()} in · {outputTokens.toLocaleString()} out $
        {costUsd.toFixed(5)}
      </Text>
    </Box>
  );
}
