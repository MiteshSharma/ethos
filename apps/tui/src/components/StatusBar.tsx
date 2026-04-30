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
  /** Live elapsed seconds — shown only while thinking (always-on timer). */
  elapsedSecs?: number;
}

function StatusIndicator({
  status,
  currentTool,
  elapsedSecs,
}: {
  status: AgentStatus;
  currentTool?: string;
  elapsedSecs?: number;
}) {
  switch (status) {
    case 'thinking':
      return (
        <Text color="yellow">
          {' thinking'}
          {elapsedSecs !== undefined && elapsedSecs > 0 ? ` ${elapsedSecs}s` : '…'}
        </Text>
      );
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
  elapsedSecs,
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
      <StatusIndicator status={status} currentTool={currentTool} elapsedSecs={elapsedSecs} />
      <Text color={skin.modelColor}>
        {'  '}
        {inputTokens.toLocaleString()} in · {outputTokens.toLocaleString()} out $
        {costUsd.toFixed(5)}
      </Text>
    </Box>
  );
}
