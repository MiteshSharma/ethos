// MCP-002 — `--env` values must not land in ~/.ethos/mcp.json (G-SEC).
// The CLI stores each value in the SecretsResolver and persists a
// `${secrets:ref}`; the client materialises it at spawn time.

import { InMemorySecretsResolver } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { mcpEnvSecretRef, resolveEnvSecretRefs, storeEnvSecrets } from '../index';

/** Built by concatenation so Biome's noTemplateCurlyInString stays quiet. */
function refExpr(ref: string): string {
  return ['${', 'secrets:', ref, '}'].join('');
}

describe('mcpEnvSecretRef', () => {
  it('namespaces by server and env key', () => {
    expect(mcpEnvSecretRef('github', 'GITHUB_TOKEN')).toBe('mcp/github/env/GITHUB_TOKEN');
  });
});

describe('storeEnvSecrets', () => {
  it('moves values into the resolver and returns refs', async () => {
    const secrets = new InMemorySecretsResolver();
    const refs = await storeEnvSecrets(
      'github',
      { GITHUB_TOKEN: 'ghp_xxx', REGION: 'eu' },
      secrets,
    );

    expect(refs).toEqual({
      GITHUB_TOKEN: refExpr('mcp/github/env/GITHUB_TOKEN'),
      REGION: refExpr('mcp/github/env/REGION'),
    });
    expect(JSON.stringify(refs)).not.toContain('ghp_xxx');
    expect(await secrets.get('mcp/github/env/GITHUB_TOKEN')).toBe('ghp_xxx');
  });
});

describe('resolveEnvSecretRefs', () => {
  it('materialises refs and passes literals through', async () => {
    const secrets = new InMemorySecretsResolver();
    await secrets.set('mcp/github/env/GITHUB_TOKEN', 'ghp_xxx');

    expect(
      await resolveEnvSecretRefs(
        'github',
        { GITHUB_TOKEN: refExpr('mcp/github/env/GITHUB_TOKEN'), PATH: '/usr/bin' },
        secrets,
      ),
    ).toEqual({ GITHUB_TOKEN: 'ghp_xxx', PATH: '/usr/bin' });
  });

  it('leaves a legacy literal value untouched', async () => {
    const secrets = new InMemorySecretsResolver();
    expect(await resolveEnvSecretRefs('legacy', { GITHUB_TOKEN: 'ghp_xxx' }, secrets)).toEqual({
      GITHUB_TOKEN: 'ghp_xxx',
    });
  });

  it('throws when the referenced secret is missing', async () => {
    const secrets = new InMemorySecretsResolver();
    await expect(
      resolveEnvSecretRefs('github', { T: refExpr('mcp/github/env/T') }, secrets),
    ).rejects.toThrow(/secret 'mcp\/github\/env\/T' not found/);
  });

  it('throws when a ref is present but no resolver is configured', async () => {
    await expect(
      resolveEnvSecretRefs('github', { T: refExpr('mcp/github/env/T') }, undefined),
    ).rejects.toThrow(/no secrets resolver is configured/);
  });

  it('is a no-op without a resolver when no value is a ref', async () => {
    expect(await resolveEnvSecretRefs('github', { PATH: '/usr/bin' }, undefined)).toEqual({
      PATH: '/usr/bin',
    });
  });
});
