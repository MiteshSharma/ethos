import { Box, Text } from 'ink';

export interface DelegationRecord {
  id: string;
  capability: string;
  status: 'pending' | 'done' | 'failed';
  durationMs?: number;
}

interface SubagentsPaneProps {
  delegations: DelegationRecord[];
}

export function SubagentsPane({ delegations }: SubagentsPaneProps) {
  if (delegations.length === 0) return null;
  return (
    <Box flexDirection="column">
      {delegations.map((d) => (
        <Box key={d.id} gap={1}>
          <Text color={d.status === 'done' ? 'green' : d.status === 'failed' ? 'red' : 'yellow'}>
            {d.status === 'done' ? '✓' : d.status === 'failed' ? '✗' : '…'}
          </Text>
          <Text dimColor>
            {d.capability}
            {d.durationMs != null ? ` ${d.durationMs}ms` : ''}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
