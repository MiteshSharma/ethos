import type { EthosConfig } from '@ethosagent/config';
import { InMemorySecretsResolver } from '@ethosagent/storage-fs';
import { describe, expect, it, vi } from 'vitest';
import { checkCodexModel } from '../commands/doctor';

// Doctor's codex-model row. Discovery is injected — never the real models
// endpoint — mirroring doctor-callcapture.test.ts's injectable dependency check.

async function secretsWithTokens() {
  const secrets = new InMemorySecretsResolver();
  await secrets.set(
    'providers/codex/tokens',
    JSON.stringify({
      accessToken: 'tok',
      refreshToken: 'r',
      idToken: 'i',
      accountId: 'acct',
      expiresAt: '2099-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  return secrets;
}

function config(provider: string, model: string): EthosConfig {
  return { provider, model } as EthosConfig;
}

const live = (models: string[]) => vi.fn(async () => ({ models, source: 'live' as const }));

describe('checkCodexModel', () => {
  it('skips (and never discovers) for a non-codex provider', async () => {
    const discover = live(['gpt-5.6-terra']);
    const result = await checkCodexModel(
      config('anthropic', 'claude-sonnet-5'),
      await secretsWithTokens(),
      {
        discover,
      },
    );
    expect(result).toEqual({ status: 'skipped' });
    expect(discover).not.toHaveBeenCalled();
  });

  it('reports ok when the model is on the live roster', async () => {
    const discover = live(['gpt-5.6-terra', 'gpt-5.6-sol']);
    const result = await checkCodexModel(
      config('codex', 'gpt-5.6-terra'),
      await secretsWithTokens(),
      {
        discover,
      },
    );
    expect(result).toEqual({ status: 'ok', model: 'gpt-5.6-terra' });
    expect(discover).toHaveBeenCalledWith('tok');
  });

  it('reports unsupported with the roster when the model is absent', async () => {
    const result = await checkCodexModel(config('codex', 'gpt-5.6'), await secretsWithTokens(), {
      discover: live(['gpt-5.6-terra', 'gpt-5.6-sol']),
    });
    expect(result).toEqual({
      status: 'unsupported',
      model: 'gpt-5.6',
      supported: ['gpt-5.6-terra', 'gpt-5.6-sol'],
    });
  });

  it('reports unverified when discovery fell back — the static roster proves nothing', async () => {
    const result = await checkCodexModel(config('codex', 'gpt-5.6'), await secretsWithTokens(), {
      discover: async () => ({ models: ['gpt-5.6-terra'], source: 'fallback' as const }),
    });
    expect(result).toEqual({ status: 'unverified', model: 'gpt-5.6' });
  });
});
