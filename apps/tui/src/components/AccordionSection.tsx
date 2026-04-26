import { Box, Text } from 'ink';

export type DetailsMode = 'hidden' | 'collapsed' | 'expanded';

interface AccordionSectionProps {
  title: string;
  mode: DetailsMode;
  count?: number;
  children: React.ReactNode;
}

export function AccordionSection({ title, mode, count, children }: AccordionSectionProps) {
  if (mode === 'hidden') return null;

  if (mode === 'collapsed') {
    return (
      <Box marginBottom={1}>
        <Text dimColor>
          ▶ {title}
          {count != null ? ` (${count})` : ''}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>▼ {title}</Text>
      <Box flexDirection="column" paddingLeft={2}>
        {children}
      </Box>
    </Box>
  );
}
