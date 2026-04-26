import { Box, Text } from 'ink';

export interface SlashCommand {
  name: string;
  desc: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'help', desc: 'Show all commands' },
  { name: 'new', desc: 'Start a fresh session' },
  { name: 'personality', desc: 'List or switch personality' },
  { name: 'model', desc: 'Open model picker' },
  { name: 'sessions', desc: 'Open session picker' },
  { name: 'memory', desc: 'Show memory content' },
  { name: 'usage', desc: 'Token and cost stats' },
  { name: 'details', desc: 'Toggle section visibility' },
  { name: 'skin', desc: 'Switch UI theme' },
  { name: 'exit', desc: 'Quit' },
];

export function getMatches(input: string): SlashCommand[] {
  if (!input.startsWith('/')) return [];
  const prefix = input.slice(1).split(/\s+/)[0]?.toLowerCase() ?? '';
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
}

interface CompletionPanelProps {
  matches: SlashCommand[];
  selectedIndex: number;
}

export function CompletionPanel({ matches, selectedIndex }: CompletionPanelProps) {
  if (matches.length === 0) return null;
  return (
    <Box flexDirection="column" borderStyle="single" borderDimColor paddingX={1}>
      {matches.map((cmd, i) => (
        <Box key={cmd.name} gap={1}>
          <Text color={i === selectedIndex ? 'cyan' : undefined} bold={i === selectedIndex}>
            /{cmd.name}
          </Text>
          <Text dimColor>— {cmd.desc}</Text>
        </Box>
      ))}
      <Text dimColor>↑/↓ navigate · Tab/Enter select · Esc dismiss</Text>
    </Box>
  );
}
