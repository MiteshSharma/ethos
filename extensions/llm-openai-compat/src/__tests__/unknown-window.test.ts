// Lane 0 — the 16k floor is inert when the window was never RESOLVED: a full
// miss defaults maxContextTokens to 128,000, which sails over the floor while
// the local server may really serve 4,096. The factory must emit a loud named
// diagnostic on local dialects (warn, not throw — warn-first release).

import type { Logger, SecretsResolver } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { openaiCompatFactory } from '../index';

const noopSecrets: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};

function captureLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = [];
  const logger: Logger = {
    info: () => {},
    warn: (msg: string) => {
      warns.push(msg);
    },
    error: () => {},
    debug: () => {},
    child: () => logger,
  };
  return { logger, warns };
}

function unknownWindowWarns(warns: string[]): string[] {
  return warns.filter((w) => w.includes('is unknown; assuming 128000'));
}

describe('openaiCompatFactory — unknown-window diagnostic (Lane 0)', () => {
  it('warns loudly for ollama when no window was resolved, naming contextWindow', async () => {
    const { logger, warns } = captureLogger();
    const provider = await openaiCompatFactory({
      config: {
        provider: 'ollama',
        model: 'qwen3',
        apiKey: 'local',
        baseUrl: 'http://localhost:11434/v1',
      },
      secrets: noopSecrets,
      logger,
    });
    expect(provider.maxContextTokens).toBe(128_000);
    const hits = unknownWindowWarns(warns);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/window for qwen3 on ollama is unknown; assuming 128000/);
    expect(hits[0]).toContain('contextWindow');
    expect(hits[0]).toContain('~/.ethos/config.yaml');
  });

  it('warns for vllm too', async () => {
    const { logger, warns } = captureLogger();
    await openaiCompatFactory({
      config: {
        provider: 'vllm',
        model: 'qwen2.5',
        apiKey: 'local',
        baseUrl: 'http://localhost:8000/v1',
      },
      secrets: noopSecrets,
      logger,
    });
    expect(unknownWindowWarns(warns)).toHaveLength(1);
  });

  it('stays silent when the window WAS resolved (maxContextTokens present)', async () => {
    const { logger, warns } = captureLogger();
    await openaiCompatFactory({
      config: {
        provider: 'ollama',
        model: 'qwen3',
        apiKey: 'local',
        baseUrl: 'http://localhost:11434/v1',
        maxContextTokens: 32_768,
      },
      secrets: noopSecrets,
      logger,
    });
    expect(unknownWindowWarns(warns)).toHaveLength(0);
  });

  it('stays silent on hosted dialects — a hosted catalog miss is not a local hazard', async () => {
    const { logger, warns } = captureLogger();
    await openaiCompatFactory({
      config: {
        provider: 'openrouter',
        model: 'some/model',
        apiKey: 'sk',
        baseUrl: 'https://openrouter.ai/api/v1',
      },
      secrets: noopSecrets,
      logger,
    });
    expect(unknownWindowWarns(warns)).toHaveLength(0);
  });
});
