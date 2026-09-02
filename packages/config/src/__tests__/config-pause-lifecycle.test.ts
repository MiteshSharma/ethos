// The `pauseLifecycle.http.<field>` operator block — notifies an external
// orchestrator of pause/resume lifecycle events over HTTP. Mirrors the
// `pauseClockCorrection` block's contract (see config-pause-clock-correction.test.ts):
// an operator/deployment concern, NOT personality identity.
//
// The load-bearing property pinned here is DEFAULT-OFF BY OMISSION: an absent
// block must leave `pauseLifecycle` undefined, so every existing deployment
// behaves exactly as it did before the feature existed.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ethosDir, readConfig, readRawConfig, writeConfig } from '../index';

async function load(yaml: string) {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  return readRawConfig(storage);
}

const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

describe('pauseLifecycle config block', () => {
  afterEach(() => {
    delete process.env.ETHOS_ORCHESTRATOR_URL;
    delete process.env.ETHOS_ORCHESTRATOR_TOKEN;
  });

  it('is absent entirely when the block is not set', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.pauseLifecycle).toBeUndefined();
  });

  it('parses the full block', async () => {
    const cfg = await load(
      [
        ...base,
        'pauseLifecycle.http.url: https://orchestrator.example.com/tenants/t1/idle',
        'pauseLifecycle.http.token: secret-token',
        'pauseLifecycle.http.timeoutMs: 5000',
      ].join('\n'),
    );
    expect(cfg?.pauseLifecycle).toEqual({
      http: {
        url: 'https://orchestrator.example.com/tenants/t1/idle',
        token: 'secret-token',
        timeoutMs: 5000,
      },
    });
  });

  it('accepts a partial block', async () => {
    const cfg = await load([...base, 'pauseLifecycle.http.token: secret-token'].join('\n'));
    expect(cfg?.pauseLifecycle).toEqual({ http: { token: 'secret-token' } });
  });

  it('ignores a blank or non-positive timeoutMs rather than making it zero', async () => {
    for (const raw of ['', '0', '-1', '1.5', 'soon']) {
      const cfg = await load(
        [
          ...base,
          'pauseLifecycle.http.url: https://example.com/idle',
          `pauseLifecycle.http.timeoutMs: ${raw}`,
        ].join('\n'),
      );
      expect(cfg?.pauseLifecycle).toEqual({ http: { url: 'https://example.com/idle' } });
    }
  });

  it('ETHOS_ORCHESTRATOR_URL overrides the yaml url', async () => {
    process.env.ETHOS_ORCHESTRATOR_URL = 'https://env.example.com/idle';
    const cfg = await load(
      [...base, 'pauseLifecycle.http.url: https://yaml.example.com/idle'].join('\n'),
    );
    expect(cfg?.pauseLifecycle?.http?.url).toBe('https://env.example.com/idle');
  });

  it('ETHOS_ORCHESTRATOR_TOKEN overrides the yaml token', async () => {
    process.env.ETHOS_ORCHESTRATOR_TOKEN = 'env-token';
    const cfg = await load([...base, 'pauseLifecycle.http.token: yaml-token'].join('\n'));
    expect(cfg?.pauseLifecycle?.http?.token).toBe('env-token');
  });

  it('env vars alone create the block even when the yaml section is absent', async () => {
    process.env.ETHOS_ORCHESTRATOR_URL = 'https://env.example.com/idle';
    const cfg = await load(base.join('\n'));
    expect(cfg?.pauseLifecycle).toEqual({ http: { url: 'https://env.example.com/idle' } });
  });

  it('round-trips through writeConfig; the token is vaulted, not written as plaintext', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await writeConfig(
      storage,
      {
        provider: 'ollama',
        model: 'llama3.2',
        apiKey: 'sk',
        personality: 'p',
        pauseLifecycle: {
          http: {
            url: 'https://orchestrator.example.com/tenants/t1/idle',
            token: 'secret-token',
            timeoutMs: 5000,
          },
        },
      },
      secrets,
    );
    const raw = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';
    expect(raw).toContain(
      'pauseLifecycle.http.url: https://orchestrator.example.com/tenants/t1/idle',
    );
    expect(raw).toContain('pauseLifecycle.http.timeoutMs: 5000');
    expect(raw).not.toContain('secret-token');

    const resolved = await readConfig(storage, secrets);
    expect(resolved?.pauseLifecycle).toEqual({
      http: {
        url: 'https://orchestrator.example.com/tenants/t1/idle',
        token: 'secret-token',
        timeoutMs: 5000,
      },
    });
  });
});
