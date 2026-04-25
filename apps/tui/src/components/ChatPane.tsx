import { Box, Text } from 'ink';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

interface ChatPaneProps {
  messages: ChatMessage[];
  streamingText: string;
}

// Show only the last N messages to keep the render height bounded.
const MAX_VISIBLE = 12;

export function ChatPane({ messages, streamingText }: ChatPaneProps) {
  const visible = messages.slice(-MAX_VISIBLE);
  return (
    <Box flexDirection="column" marginBottom={1}>
      {visible.map((msg) => (
        <Box key={msg.id} flexDirection="column" marginBottom={1}>
          {msg.role === 'user' ? (
            <Box gap={1}>
              <Text color="cyan" bold>
                You
              </Text>
              <Text dimColor>›</Text>
              <Text wrap="wrap">{msg.text}</Text>
            </Box>
          ) : (
            <Box gap={1}>
              <Text color="green" bold>
                ethos
              </Text>
              <Text dimColor>›</Text>
              <Text wrap="wrap">{msg.text}</Text>
            </Box>
          )}
        </Box>
      ))}
      {streamingText && (
        <Box gap={1}>
          <Text color="green" bold>
            ethos
          </Text>
          <Text dimColor>›</Text>
          <Text wrap="wrap">{streamingText}</Text>
        </Box>
      )}
    </Box>
  );
}
