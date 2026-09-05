import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CODEX_DISCOVERY_CACHE_TTL_MS,
  CODEX_FALLBACK_MODELS,
  CODEX_MODELS_URL,
  discoverModels,
  discoverModelsCached,
  modelRejectionHint,
  resetModelDiscoveryCache,
  unsupportedModelMessage,
} from '../models';

function fetchReturning(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as typeof fetch;
}

const LIVE = { models: [{ id: 'gpt-5.6-terra' }, { id: 'gpt-5.6-sol' }] };

describe('discoverModels', () => {
  it('returns the live roster with the bearer token', async () => {
    const fetchFn = fetchReturning(200, LIVE);
    const result = await discoverModels('tok', fetchFn);
    expect(result).toEqual({ models: ['gpt-5.6-terra', 'gpt-5.6-sol'], source: 'live' });
    const [url, init] = vi.mocked(fetchFn).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CODEX_MODELS_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('falls back on a non-2xx reply', async () => {
    const result = await discoverModels('tok', fetchReturning(401, { detail: 'nope' }));
    expect(result).toEqual({ models: CODEX_FALLBACK_MODELS, source: 'fallback' });
  });

  it('falls back on a body that does not match the schema', async () => {
    expect((await discoverModels('tok', fetchReturning(200, { data: [] }))).source).toBe(
      'fallback',
    );
    expect((await discoverModels('tok', fetchReturning(200, { models: [] }))).source).toBe(
      'fallback',
    );
    expect(
      (await discoverModels('tok', fetchReturning(200, { models: [{ name: 'x' }] }))).source,
    ).toBe('fallback');
  });

  it('falls back when fetch throws', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    expect((await discoverModels('tok', fetchFn)).source).toBe('fallback');
  });
});

describe('discoverModelsCached', () => {
  beforeEach(() => resetModelDiscoveryCache());

  it('reuses a result inside the TTL and refetches after it', async () => {
    const fetchFn = fetchReturning(200, LIVE);
    await discoverModelsCached('tok', fetchFn, 1_000);
    await discoverModelsCached('tok', fetchFn, 1_000 + CODEX_DISCOVERY_CACHE_TTL_MS - 1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await discoverModelsCached('tok', fetchFn, 1_000 + CODEX_DISCOVERY_CACHE_TTL_MS);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('modelRejectionHint', () => {
  beforeEach(() => resetModelDiscoveryCache());

  const REJECTION = JSON.stringify({
    detail: "The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account.",
  });

  it('uses the static roster before any discovery has run', () => {
    expect(modelRejectionHint(REJECTION, 'gpt-5.6')).toBe(
      unsupportedModelMessage('gpt-5.6', CODEX_FALLBACK_MODELS),
    );
  });

  it('uses the cached live roster once discovery has run', async () => {
    await discoverModelsCached('tok', fetchReturning(200, LIVE));
    expect(modelRejectionHint(REJECTION, 'gpt-5.6')).toBe(
      'Codex: model "gpt-5.6" is not available to this ChatGPT account. Supported: gpt-5.6-terra, gpt-5.6-sol — set `model:` in ~/.ethos/config.yaml to one of these.',
    );
  });

  it('returns null for a 400 that is not about the model, or is not JSON', () => {
    expect(
      modelRejectionHint(
        JSON.stringify({ detail: 'Unsupported parameter: max_output_tokens' }),
        'm',
      ),
    ).toBeNull();
    expect(modelRejectionHint(JSON.stringify({ error: 'model not supported' }), 'm')).toBeNull();
    expect(modelRejectionHint('<html>Bad Request</html>', 'm')).toBeNull();
  });
});
