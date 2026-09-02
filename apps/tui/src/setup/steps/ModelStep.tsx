import { fetchLocalModels } from '@ethosagent/wiring/local-models';
import {
  formatContextWindow,
  getDefaultModel,
  getModelsForProvider,
  MIN_CONTEXT_WINDOW,
} from '@ethosagent/wiring/model-catalog';
import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';
import { localProviderPlan } from '../local-provider';

export function ModelStep() {
  const { answers } = useWizardContext();
  const providerId = answers.provider ?? 'anthropic';
  if (localProviderPlan(providerId).isLocal) {
    return <LocalModelStep />;
  }
  return <CatalogModelStep />;
}

// ---------------------------------------------------------------------------
// Local providers (ollama, vllm): drive the model choice from GET /v1/models.
// Reachable → pick from the served list; unreachable/timeout → free-text entry.
// ---------------------------------------------------------------------------

type LocalPhase = 'loading' | 'list' | 'manual';

function LocalModelStep() {
  const { answers, dispatch } = useWizardContext();
  const providerId = answers.provider ?? 'ollama';
  const baseUrl = answers.baseUrl ?? localProviderPlan(providerId).defaultBaseUrl ?? '';

  const [phase, setPhase] = useState<LocalPhase>('loading');
  const [models, setModels] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [manual, setManual] = useState(answers.model ?? '');

  // Fetch the served model list on mount. The helper already times out fast
  // (2.5s) so the wizard never hangs on an unreachable endpoint.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { reachable, models: served } = await fetchLocalModels(baseUrl);
      if (cancelled) return;
      if (reachable && served.length > 0) {
        setModels(served);
        const idx = answers.model ? served.indexOf(answers.model) : -1;
        setSelected(idx >= 0 ? idx : 0);
        setPhase('list');
      } else {
        setPhase('manual');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, answers.model]);

  useInput((input, key) => {
    if (phase === 'loading') {
      if (key.escape) dispatch({ type: 'back' });
      return;
    }
    if (phase === 'list') {
      if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
      if (key.downArrow) setSelected((s) => Math.min(models.length - 1, s + 1));
      if (key.return) {
        const m = models[selected];
        if (m) dispatch({ type: 'next', patch: { model: m } });
      }
      if (key.escape) dispatch({ type: 'back' });
      return;
    }
    // phase === 'manual'
    if (key.escape) {
      dispatch({ type: 'back' });
      return;
    }
    if (key.return) {
      const m = manual.trim();
      if (m) dispatch({ type: 'next', patch: { model: m } });
      return;
    }
    if (key.backspace || key.delete) {
      setManual((v) => v.slice(0, -1));
      return;
    }
    if (!key.ctrl && !key.meta && input) {
      setManual((v) => v + input);
    }
  });

  if (phase === 'loading') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={DESIGN.textPrimary} bold>
          Choose a model:
        </Text>
        <Text color={DESIGN.textSecondary}>{`  Checking ${baseUrl} for available models…`}</Text>
        <Text color={DESIGN.textTertiary}>{'  Esc back'}</Text>
      </Box>
    );
  }

  if (phase === 'manual') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={DESIGN.textPrimary} bold>
          Enter a model name:
        </Text>
        <Text
          color={DESIGN.textTertiary}
        >{`  ${baseUrl} not reachable — type the model to use.`}</Text>
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Text color={DESIGN.textPrimary}>{`  ${GLYPHS.prompt} `}</Text>
          <Text color={manual ? DESIGN.textPrimary : DESIGN.textTertiary}>
            {manual || 'e.g. llama3.2'}
          </Text>
        </Box>
        <Text color={DESIGN.textTertiary}>{'  Enter confirm   Esc back'}</Text>
      </Box>
    );
  }

  // phase === 'list'
  return (
    <Box flexDirection="column" gap={1}>
      <Text color={DESIGN.textPrimary} bold>
        Choose a model:
      </Text>
      <Text color={DESIGN.textTertiary}>{`  Served by ${baseUrl}`}</Text>
      <Box flexDirection="column">
        {models.map((m, i) => {
          const isSelected = i === selected;
          const cursor = isSelected ? GLYPHS.prompt : ' ';
          const isCurrent = answers.model === m;
          return (
            <Box key={m} flexDirection="row" gap={1}>
              <Text color={DESIGN.textPrimary}>{` ${cursor} `}</Text>
              <Text
                color={
                  isCurrent
                    ? DESIGN.success
                    : isSelected
                      ? DESIGN.textPrimary
                      : DESIGN.textSecondary
                }
                bold={isSelected}
              >
                {m}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Text color={DESIGN.textTertiary}>{'  ↑↓ select   Enter confirm   Esc back'}</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Catalog providers: pick from the static model catalog.
// ---------------------------------------------------------------------------

function CatalogModelStep() {
  const { answers, dispatch } = useWizardContext();
  const providerId = answers.provider ?? 'anthropic';
  const models = getModelsForProvider(providerId);
  const defaultModel = getDefaultModel(providerId);
  // Providers whose model ids are account- or region-specific (bedrock) carry
  // no catalog rows — fall back to free-text entry instead of an empty list.
  const isManual = models.length === 0;

  const [selected, setSelected] = useState(() => {
    const idx = models.findIndex(
      (m) => m.modelId === answers.model || (m.default && !answers.model),
    );
    return Math.max(0, idx);
  });
  const [manual, setManual] = useState(answers.model ?? '');

  useInput((input, key) => {
    if (isManual) {
      if (key.escape) {
        dispatch({ type: 'back' });
        return;
      }
      if (key.return) {
        const m = manual.trim();
        if (m) dispatch({ type: 'next', patch: { model: m } });
        return;
      }
      if (key.backspace || key.delete) {
        setManual((v) => v.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input) setManual((v) => v + input);
      return;
    }
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(models.length - 1, s + 1));
    if (key.return) {
      const m = models[selected] ?? defaultModel;
      if (m) dispatch({ type: 'next', patch: { model: m.modelId } });
    }
    if (key.escape) dispatch({ type: 'back' });
  });

  if (isManual) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={DESIGN.textPrimary} bold>
          Enter a model ID:
        </Text>
        <Text color={DESIGN.textTertiary}>
          {'  No preset models for this provider — IDs are account-specific.'}
        </Text>
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Text color={DESIGN.textPrimary}>{`  ${GLYPHS.prompt} `}</Text>
          <Text color={manual ? DESIGN.textPrimary : DESIGN.textTertiary}>
            {manual || 'e.g. us.anthropic.claude-sonnet-4-20250514-v1:0'}
          </Text>
        </Box>
        <Text color={DESIGN.textTertiary}>{'  Enter confirm   Esc back'}</Text>
      </Box>
    );
  }

  const selectedModel = models[selected];
  const showWarning = selectedModel && selectedModel.contextWindow < MIN_CONTEXT_WINDOW;

  // Fixed column widths for tabular display
  const idWidth = Math.max(...models.map((m) => m.modelId.length)) + 2;
  const labelWidth = Math.max(...models.map((m) => m.label.length)) + 2;

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={DESIGN.textPrimary} bold>
        Choose a default model:
      </Text>
      <Box flexDirection="column">
        {models.map((m, i) => {
          const isSelected = i === selected;
          const cursor = isSelected ? GLYPHS.prompt : ' ';
          const isCurrent = answers.model === m.modelId;
          const ctxStr = formatContextWindow(m.contextWindow);
          return (
            <Box key={m.modelId} flexDirection="row" gap={1}>
              <Text color={DESIGN.textPrimary}>{` ${cursor} `}</Text>
              <Text
                color={isSelected ? DESIGN.textPrimary : DESIGN.textSecondary}
                bold={isSelected}
              >
                {m.modelId.padEnd(idWidth)}
              </Text>
              <Text color={DESIGN.textTertiary}>{m.label.padEnd(labelWidth)}</Text>
              <Text color={isCurrent ? DESIGN.success : DESIGN.textTertiary}>{ctxStr}</Text>
            </Box>
          );
        })}
      </Box>
      {showWarning && (
        <Text
          color={DESIGN.warning}
        >{`  ! ${selectedModel.contextWindow / 1_000}k ctx — researcher / engineer personalities work better at ≥64k`}</Text>
      )}
      <Text color={DESIGN.textTertiary}>{'  ↑↓ select   Enter confirm   Esc back'}</Text>
    </Box>
  );
}
