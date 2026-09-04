// The secrets manifest is built from the VAULT, not from keys.json.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSecretsResolver, FsStorage, InMemorySecretsResolver } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSecretsManifest, injectSecrets } from '../secrets-manifest';

let dir: string;
let vault: FileSecretsResolver;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ethos-secrets-manifest-'));
  vault = new FileSecretsResolver({ dir: join(dir, 'secrets'), storage: new FsStorage() });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('buildSecretsManifest', () => {
  it('enumerates the real secrets/ vault, not keys.json', async () => {
    // keys.json is only the LLM key-rotation pool; a machine whose credentials
    // all live in the vault used to get an empty manifest and no warning.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'keys.json'), '{"ROTATION_POOL_ONLY":"sk-x"}');
    await vault.set('ANTHROPIC_API_KEY', 'sk-live');
    await vault.set('TELEGRAM_BOT_TOKEN', '123:abc');

    const manifest = await buildSecretsManifest({
      secrets: vault,
      strippedMcpTokens: new Map(),
      now: new Date('2026-09-04T10:00:00Z'),
    });

    expect(manifest).toContain('backed_up_at: 2026-09-04T10:00:00.000Z');
    expect(manifest).toContain('  - key: ANTHROPIC_API_KEY');
    expect(manifest).toContain('    fill_with: ethos secrets set ANTHROPIC_API_KEY <value>');
    expect(manifest).toContain('  - key: TELEGRAM_BOT_TOKEN');
    expect(manifest).not.toContain('ROTATION_POOL_ONLY');
  });

  it('never writes a value', async () => {
    await vault.set('ANTHROPIC_API_KEY', 'sk-super-secret-value');
    const manifest = await buildSecretsManifest({
      secrets: vault,
      strippedMcpTokens: new Map(),
    });
    expect(manifest).not.toContain('sk-super-secret-value');
  });

  it('groups personality-scoped refs under their personality', async () => {
    await vault.set('personalities/alice/GITHUB_TOKEN', 'ghs_x');
    await vault.set('personalities/alice/LINEAR_KEY', 'lin_x');
    await vault.set('personalities/bob/NOTION_KEY', 'nt_x');

    const manifest = await buildSecretsManifest({
      secrets: vault,
      strippedMcpTokens: new Map(),
    });
    expect(manifest).toContain('  alice:\n    secrets:\n      - key: GITHUB_TOKEN');
    expect(manifest).toContain(
      '        fill_with: ethos secrets set personalities/alice/GITHUB_TOKEN <value>',
    );
    expect(manifest).toContain('  bob:');
    expect(manifest).toContain('      - key: NOTION_KEY');
  });

  it('records which personality/server had MCP tokens stripped', async () => {
    const manifest = await buildSecretsManifest({
      secrets: vault,
      strippedMcpTokens: new Map([['alice', new Set(['github', 'linear'])]]),
    });
    expect(manifest).toContain('    mcp_auth:');
    expect(manifest).toContain('      - server: github');
    expect(manifest).toContain('        fill_with: ethos mcp auth github');
    expect(manifest).toContain('      - server: linear');
  });

  it('keeps refs it cannot group, verbatim, rather than dropping them', async () => {
    await vault.set('plugins/weather/API_KEY', 'wk_x');
    const manifest = await buildSecretsManifest({
      secrets: vault,
      strippedMcpTokens: new Map(),
    });
    expect(manifest).toContain('other:');
    expect(manifest).toContain('  - key: plugins/weather/API_KEY');
  });

  it('is stable across two backups of an unchanged vault', async () => {
    await vault.set('B_KEY', 'b');
    await vault.set('A_KEY', 'a');
    const now = new Date('2026-09-04T10:00:00Z');
    const first = await buildSecretsManifest({ secrets: vault, strippedMcpTokens: new Map(), now });
    const second = await buildSecretsManifest({
      secrets: vault,
      strippedMcpTokens: new Map(),
      now,
    });
    expect(first).toBe(second);
    expect(first.indexOf('A_KEY')).toBeLessThan(first.indexOf('B_KEY'));
  });
});

describe('injectSecrets', () => {
  it('writes global and personality-scoped values into the vault', async () => {
    const secrets = new InMemorySecretsResolver();
    const count = await injectSecrets(
      [
        '# filled in by the operator',
        'global:',
        '  ANTHROPIC_API_KEY: sk-new',
        'personalities:',
        '  alice:',
        '    GITHUB_TOKEN: "ghs_new"',
        '',
      ].join('\n'),
      secrets,
    );

    expect(count).toBe(2);
    expect(await secrets.get('ANTHROPIC_API_KEY')).toBe('sk-new');
    expect(await secrets.get('personalities/alice/GITHUB_TOKEN')).toBe('ghs_new');
  });

  it('skips a blank value so a half-filled template cannot blank a good secret', async () => {
    const secrets = new InMemorySecretsResolver();
    await secrets.set('ANTHROPIC_API_KEY', 'sk-existing');
    const count = await injectSecrets('global:\n  ANTHROPIC_API_KEY:\n', secrets);
    expect(count).toBe(0);
    expect(await secrets.get('ANTHROPIC_API_KEY')).toBe('sk-existing');
  });

  it('ignores sections it does not understand', async () => {
    const secrets = new InMemorySecretsResolver();
    const count = await injectSecrets('other:\n  plugins/x/KEY: v\n', secrets);
    expect(count).toBe(0);
  });
});
