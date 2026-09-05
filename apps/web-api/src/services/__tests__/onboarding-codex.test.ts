import { CODEX_FALLBACK_MODELS, CODEX_MODELS_URL } from '@ethosagent/llm-codex';
import type { FilePersonalityRegistry } from '@ethosagent/personalities';
import { InMemorySecretsResolver } from '@ethosagent/storage-fs';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigRepository } from '../../repositories/config.repository';
import { OnboardingService } from '../onboarding.service';

// Codex validation asks the ChatGPT account which models it can use, so the
// step-2 picker shows the live roster rather than the static guess.

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

async function makeService(fetchFn: typeof fetch) {
  const secrets = new InMemorySecretsResolver();
  await secrets.set(
    'providers/codex/tokens',
    JSON.stringify({
      accessToken: 'live-token',
      refreshToken: 'r',
      idToken: 'i',
      accountId: 'acct',
      expiresAt: '2099-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  return new OnboardingService({
    config: { read: async () => null, update: async () => {} } as unknown as ConfigRepository,
    personalities: { get: () => null } as unknown as FilePersonalityRegistry,
    secrets,
    fetchFn,
  });
}

describe('validateProvider for codex', () => {
  it('returns the models the account reports', async () => {
    const fetchFn = mockFetch(200, { models: [{ id: 'gpt-5.6-terra' }, { id: 'gpt-5.6-sol' }] });
    const svc = await makeService(fetchFn);

    const result = await svc.validateProvider({ provider: 'codex', apiKey: '' });

    expect(result).toEqual({
      ok: true,
      models: ['gpt-5.6-terra', 'gpt-5.6-sol'],
      error: null,
      completionTested: false,
    });
    const [url, init] = vi.mocked(fetchFn).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CODEX_MODELS_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer live-token');
  });

  it('falls back to the static roster when discovery fails', async () => {
    const svc = await makeService(mockFetch(500, { detail: 'upstream down' }));

    const result = await svc.validateProvider({ provider: 'codex', apiKey: '' });

    expect(result.ok).toBe(true);
    expect(result.models).toEqual(CODEX_FALLBACK_MODELS);
  });
});
