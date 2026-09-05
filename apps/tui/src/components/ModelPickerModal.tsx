import { formatContextWindow, getModelsForProvider } from '@ethosagent/wiring/model-catalog';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

export interface ModelEntry {
  id: string;
  provider: string;
  detail?: string;
}

// Derived from the wiring MODEL_CATALOG so the picker never drifts from setup.
const PICKER_PROVIDERS = ['anthropic', 'openai', 'codex', 'openrouter', 'ollama'];

const KNOWN_MODELS: ModelEntry[] = PICKER_PROVIDERS.flatMap((provider) =>
  getModelsForProvider(provider).map((m) => ({
    provider,
    id: m.modelId,
    detail: `${m.label} · ${formatContextWindow(m.contextWindow)}${m.default ? ' · default' : ''}`,
  })),
);

interface ModelPickerModalProps {
  current: string;
  onSelect: (model: ModelEntry) => void;
  onCancel: () => void;
}

export function ModelPickerModal({ current, onSelect, onCancel }: ModelPickerModalProps) {
  const initial = KNOWN_MODELS.findIndex((m) => m.id === current);
  const [selected, setSelected] = useState(initial >= 0 ? initial : 0);

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
      setSelected((s) => Math.min(KNOWN_MODELS.length - 1, s + 1));
      return;
    }
    if (key.return) {
      const entry = KNOWN_MODELS[selected];
      if (entry) onSelect(entry);
    }
  });

  // Group entries by provider for display, but keep single index for navigation.
  const providers = Array.from(new Set(KNOWN_MODELS.map((m) => m.provider)));

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text bold>Pick a model</Text>
      <Box marginTop={1} flexDirection="column">
        {providers.map((provider) => (
          <Box key={provider} flexDirection="column" marginBottom={1}>
            <Text color="yellow" bold>
              {provider}
            </Text>
            {KNOWN_MODELS.filter((m) => m.provider === provider).map((m) => {
              const idx = KNOWN_MODELS.indexOf(m);
              const isSelected = idx === selected;
              return (
                <Box key={m.id} gap={1} paddingLeft={1}>
                  <Text color={isSelected ? 'cyan' : undefined}>{isSelected ? '▶' : ' '}</Text>
                  <Text bold={isSelected}>{m.id}</Text>
                  {m.detail && <Text dimColor>— {m.detail}</Text>}
                  {m.id === current && <Text color="green">(current)</Text>}
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>
      <Text dimColor>↑/↓ navigate · Enter select · Esc cancel</Text>
    </Box>
  );
}
