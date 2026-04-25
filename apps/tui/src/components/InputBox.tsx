import { Box, Text, useInput } from 'ink';

interface InputBoxProps {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}

export function InputBox({ value, disabled, onChange, onSubmit }: InputBoxProps) {
  useInput((input, key) => {
    if (disabled) return;

    if (key.return) {
      const trimmed = value.trim();
      if (trimmed) onSubmit(trimmed);
      return;
    }

    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }

    // Ctrl+U — clear line
    if (key.ctrl && input === 'u') {
      onChange('');
      return;
    }

    // Skip all other control / meta sequences
    if (key.ctrl || key.meta) return;

    if (input) onChange(value + input);
  });

  return (
    <Box borderStyle="single" paddingX={1}>
      <Text color="cyan" bold>
        You
      </Text>
      <Text dimColor> › </Text>
      {value ? (
        <Text>
          {value}
          <Text inverse> </Text>
        </Text>
      ) : (
        <Text dimColor>
          {disabled ? 'waiting…' : 'Type a message or /help…'}
          <Text inverse> </Text>
        </Text>
      )}
    </Box>
  );
}
