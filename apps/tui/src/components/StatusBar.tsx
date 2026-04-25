import { Box, Text } from 'ink';

interface StatusBarProps {
  model: string;
  personality: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  running: boolean;
}

export function StatusBar({
  model,
  personality,
  inputTokens,
  outputTokens,
  costUsd,
  running,
}: StatusBarProps) {
  return (
    <Box marginBottom={1}>
      <Text bold>ethos</Text>
      <Text dimColor>
        {' '}
        {model} · {personality}
      </Text>
      {running && <Text color="yellow"> ●</Text>}
      <Text dimColor>
        {'  '}
        {inputTokens.toLocaleString()} in · {outputTokens.toLocaleString()} out $
        {costUsd.toFixed(5)}
      </Text>
    </Box>
  );
}
