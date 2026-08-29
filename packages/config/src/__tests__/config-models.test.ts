// §7 — per-model profile overrides (`models.<providerId>/<modelId>.<field>`).

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../index';

describe('models: per-model profile config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

  it('parses sampling + toolCallFormat + maxOutputTokens for a model', async () => {
    const cfg = await load(
      [
        ...base,
        'models.ollama/llama3.2.sampling.temperature: 0.2',
        'models.ollama/llama3.2.sampling.topP: 0.9',
        'models.ollama/llama3.2.sampling.topK: 40',
        'models.ollama/llama3.2.sampling.minP: 0.05',
        'models.ollama/llama3.2.toolCallFormat: text-xml',
        'models.ollama/llama3.2.maxOutputTokens: 2048',
      ].join('\n'),
    );
    expect(cfg?.models?.['ollama/llama3.2']).toEqual({
      sampling: { temperature: 0.2, topP: 0.9, topK: 40, minP: 0.05 },
      toolCallFormat: 'text-xml',
      maxOutputTokens: 2048,
    });
  });

  it('handles model ids containing slashes (openrouter/anthropic/...)', async () => {
    const cfg = await load(
      [...base, 'models.openrouter/anthropic/claude-sonnet-4-6.sampling.temperature: 0.4'].join(
        '\n',
      ),
    );
    expect(cfg?.models?.['openrouter/anthropic/claude-sonnet-4-6']).toEqual({
      sampling: { temperature: 0.4 },
    });
  });

  it('drops an invalid toolCallFormat enum value', async () => {
    const cfg = await load([...base, 'models.ollama/llama3.2.toolCallFormat: grpc'].join('\n'));
    expect(cfg?.models?.['ollama/llama3.2']).toBeUndefined();
  });

  it('leaves models undefined when no keys are present', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.models).toBeUndefined();
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'sk',
      personality: 'researcher',
      models: {
        'ollama/llama3.2': {
          sampling: { temperature: 0.2, topK: 40 },
          toolCallFormat: 'text-xml' as const,
          maxOutputTokens: 2048,
        },
      },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.models).toEqual(original.models);
  });
});
