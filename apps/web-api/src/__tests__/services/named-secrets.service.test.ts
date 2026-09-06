import { InMemorySecretsResolver } from '@ethosagent/storage-fs';
import { isEthosError } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NamedSecretsService, redactSecret } from '../../services/named-secrets.service';

describe('redactSecret', () => {
  it('masks the value and never returns it verbatim', () => {
    expect(redactSecret('sk-exa-1234567890abcdef')).toBe('sk-…cdef');
    // Below the 10-char boundary we do NOT reveal a suffix — a short key would
    // over-expose (a 6-char key showing 4 chars leaks two-thirds of it).
    expect(redactSecret('123456')).toBe('<set>');
    expect(redactSecret('abc')).toBe('<set>');
    expect(redactSecret('')).toBe('<unset>');
    expect(redactSecret(null)).toBe('<unset>');
  });
});

describe('NamedSecretsService', () => {
  let secrets: InMemorySecretsResolver;
  let service: NamedSecretsService;

  beforeEach(() => {
    secrets = new InMemorySecretsResolver();
    service = new NamedSecretsService({ secrets });
  });

  it('create writes to providers/<provider>/<name> in the vault', async () => {
    const res = await service.create({
      provider: 'exa',
      name: 'main',
      value: 'sk-exa-secret-value',
    });
    expect(res.ok).toBe(true);
    expect(await secrets.get('providers/exa/main')).toBe('sk-exa-secret-value');
    // The create response carries only a masked preview — never the raw value.
    expect(res.preview).not.toContain('secret-value');
    expect(res.preview).toBe('sk-…alue');
  });

  it('list returns masked previews only — the raw value never crosses the boundary', async () => {
    await service.create({ provider: 'tavily', name: 'work', value: 'tvly-abcdef123456' });
    const { secrets: list } = await service.list();
    expect(list).toHaveLength(1);
    const row = list[0];
    if (!row) throw new Error('expected one secret');
    expect(row.provider).toBe('tavily');
    expect(row.name).toBe('work');
    expect(row.kind).toBe('web-search');
    expect(row.preview).not.toContain('abcdef');
    // Nothing on the wire row equals the stored value.
    expect(JSON.stringify(row)).not.toContain('tvly-abcdef123456');
  });

  it('list spans every provider namespace and stamps each row with its kind', async () => {
    await service.create({ provider: 'exa', name: 'main', value: 'sk-exa-1234567890' });
    await service.create({ provider: 'xai', name: 'grok', value: 'xai-1234567890abcd' });
    await service.create({ provider: 'x', name: 'bearer', value: 'AAAA-bearer-1234567890' });
    const { secrets: list } = await service.list();
    expect(list.map((r) => [r.provider, r.name, r.kind])).toEqual([
      ['exa', 'main', 'web-search'],
      ['x', 'bearer', 'x-api'],
      ['xai', 'grok', 'x-search'],
    ]);
  });

  it('accepts the xai and x provider namespaces', async () => {
    await service.create({ provider: 'xai', name: 'k', value: 'xai-1234567890abcd' });
    await service.create({ provider: 'x', name: 'k', value: 'AAAA-bearer-1234567890' });
    expect(await secrets.get('providers/xai/k')).toBe('xai-1234567890abcd');
    expect(await secrets.get('providers/x/k')).toBe('AAAA-bearer-1234567890');
  });

  it('delete removes the secret from the vault', async () => {
    await service.create({ provider: 'brave', name: 'k1', value: 'brave-xxxxxxxx' });
    await service.delete({ provider: 'brave', name: 'k1' });
    expect(await secrets.get('providers/brave/k1')).toBeNull();
    expect((await service.list()).secrets).toHaveLength(0);
  });

  it('rejects providers outside the named-secret namespaces', async () => {
    try {
      await service.create({ provider: 'openai', name: 'main', value: 'x' });
      throw new Error('expected throw');
    } catch (err) {
      expect(isEthosError(err)).toBe(true);
    }
  });

  it('rejects invalid secret names', async () => {
    try {
      await service.create({ provider: 'exa', name: 'bad/name', value: 'x' });
      throw new Error('expected throw');
    } catch (err) {
      expect(isEthosError(err)).toBe(true);
    }
  });

  it('rejects an over-cap value (DoS guard)', async () => {
    const huge = 'x'.repeat(8 * 1024 + 1);
    try {
      await service.create({ provider: 'exa', name: 'big', value: huge });
      throw new Error('expected throw');
    } catch (err) {
      expect(isEthosError(err)).toBe(true);
    }
    // Nothing was written to the vault.
    expect(await secrets.get('providers/exa/big')).toBeNull();
  });

  describe('testKey', () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('returns a shape with no value/key/preview field', async () => {
      await service.create({ provider: 'exa', name: 'main', value: 'sk-exa-secret-value' });
      globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
      const res = await service.testKey({ provider: 'exa', name: 'main' });
      expect(res.ok).toBe(true);
      expect(Object.keys(res).sort()).toEqual(['ok']);
      // Belt-and-braces: the raw value never appears anywhere on the wire.
      expect(JSON.stringify(res)).not.toContain('secret-value');
    });

    it('early-returns when the secret is missing — no HTTP call', async () => {
      let called = false;
      globalThis.fetch = (async () => {
        called = true;
        return new Response('{}', { status: 200 });
      }) as typeof fetch;
      const res = await service.testKey({ provider: 'exa', name: 'absent' });
      expect(res).toEqual({ ok: false, error: 'Secret not found.' });
      expect(called).toBe(false);
    });

    it('rejects invalid input with an EthosError (code INVALID_INPUT)', async () => {
      try {
        await service.testKey({ provider: 'nope', name: 'main' });
        throw new Error('expected throw');
      } catch (err) {
        expect(isEthosError(err)).toBe(true);
        if (isEthosError(err)) expect(err.code).toBe('INVALID_INPUT');
      }
    });

    it('maps a 401 to an unauthorized result', async () => {
      await service.create({ provider: 'brave', name: 'k', value: 'brave-xxxxxxxx' });
      globalThis.fetch = (async () => new Response('', { status: 401 })) as typeof fetch;
      const res = await service.testKey({ provider: 'brave', name: 'k' });
      expect(res).toEqual({ ok: false, error: 'Key rejected (unauthorized).' });
    });

    it('probes an xai key against /v1/models with a bearer header (200 → ok)', async () => {
      await service.create({ provider: 'xai', name: 'grok', value: 'xai-1234567890abcd' });
      let seen: { url: string; auth: string | null } | undefined;
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        seen = { url: String(url), auth: new Headers(init?.headers).get('Authorization') };
        return new Response('{"data":[]}', { status: 200 });
      }) as typeof fetch;
      const res = await service.testKey({ provider: 'xai', name: 'grok' });
      expect(res).toEqual({ ok: true });
      expect(seen?.url).toBe('https://api.x.ai/v1/models');
      expect(seen?.auth).toBe('Bearer xai-1234567890abcd');
    });

    it('maps an xai 401 to an unauthorized result', async () => {
      await service.create({ provider: 'xai', name: 'grok', value: 'xai-1234567890abcd' });
      globalThis.fetch = (async () => new Response('', { status: 401 })) as typeof fetch;
      const res = await service.testKey({ provider: 'xai', name: 'grok' });
      expect(res).toEqual({ ok: false, error: 'Key rejected (unauthorized).' });
    });

    it('does not probe an x bearer token (a search call is billable) — reports tested: false', async () => {
      await service.create({ provider: 'x', name: 'bearer', value: 'AAAA-bearer-1234567890' });
      let called = false;
      globalThis.fetch = (async () => {
        called = true;
        return new Response('{}', { status: 200 });
      }) as typeof fetch;
      const res = await service.testKey({ provider: 'x', name: 'bearer' });
      expect(res).toEqual({ ok: true, tested: false });
      expect(called).toBe(false);
    });

    it('sanitizes a thrown fetch error — never echoes the raw message', async () => {
      await service.create({ provider: 'tavily', name: 'k', value: 'tvly-abcdef123456' });
      globalThis.fetch = (async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.1:443 x-api-key: tvly-abcdef123456');
      }) as typeof fetch;
      const res = await service.testKey({ provider: 'tavily', name: 'k' });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('Key check could not be completed.');
      // The raw error text (which carried the key) must not leak back out.
      expect(JSON.stringify(res)).not.toContain('tvly-abcdef123456');
      expect(JSON.stringify(res)).not.toContain('ECONNREFUSED');
    });

    it('reports a timeout distinctly (AbortError)', async () => {
      await service.create({ provider: 'exa', name: 'k', value: 'sk-exa-1234567890' });
      globalThis.fetch = (async () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }) as typeof fetch;
      const res = await service.testKey({ provider: 'exa', name: 'k' });
      expect(res).toEqual({ ok: false, error: 'Key check timed out.' });
    });
  });
});
