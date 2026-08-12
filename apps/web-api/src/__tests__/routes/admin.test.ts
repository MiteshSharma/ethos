import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage, InMemoryStorage } from '@ethosagent/storage-fs';
import type { SecretsResolver } from '@ethosagent/types';
import { call } from '@orpc/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import { ConfigRepository } from '../../repositories/config.repository';
import { adminRouter } from '../../rpc/admin';
import type { RpcContext } from '../../rpc/context';
import { ConfigService } from '../../services/config.service';
import type { ValidateProviderInput } from '../../services/onboarding.service';
import {
  makeStubAgentLoop,
  makeStubMemoryProvider,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// Admin RPC namespace — gated by `admin.enabled: true` in config.yaml
// (default false). Disabled → every procedure returns 403 FORBIDDEN;
// enabled → procedures behave normally. HTTP-level via Hono's
// `app.request(...)`, same pattern as auth-and-rpc.test.ts.

const BASE_CONFIG = ['provider: anthropic', 'model: claude-test', 'apiKey: sk-test-1234567890'];

describe('admin RPCs — gated by admin.enabled', () => {
  let dir: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;

  async function boot(configLines: string[]): Promise<void> {
    await writeFile(join(dir, 'config.yaml'), `${configLines.join('\n')}\n`);
    app = createWebApi({
      dataDir: dir,
      sessionStore: store,
      memoryProvider: makeStubMemoryProvider(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
    }).app;
    const tokens = new WebTokenRepository({ dataDir: dir, storage: new FsStorage() });
    const token = await tokens.getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000' },
    });
    const setCookie = exchange.headers.get('set-cookie') ?? '';
    cookie = setCookie.split(/;\s*/)[0] ?? '';
    expect(cookie).toMatch(/ethos_auth=/);
  }

  async function rpcPost(path: string, input: unknown): Promise<Response> {
    return app.request(`/rpc/admin/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ json: input }),
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-webapi-admin-'));
    store = new SQLiteSessionStore(':memory:');
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('admin disabled (no admin.enabled key) → 403 on every admin procedure', async () => {
    await boot(BASE_CONFIG);
    const calls: Array<[string, unknown]> = [
      ['getStatus', {}],
      ['rotateKey', { provider: 'anthropic', key: 'sk-new' }],
      ['checkProvider', { provider: 'anthropic' }],
      ['testSend', { channel: 'telegram' }],
      ['addMcpServer', { name: 'srv', url: 'https://example.com/mcp', authType: 'none' }],
      ['removeMcpServer', { name: 'srv' }],
    ];
    for (const [path, input] of calls) {
      const res = await rpcPost(path, input);
      expect(res.status, `admin/${path}`).toBe(403);
      const body = (await res.json()) as { json?: { code?: string } };
      expect(body.json?.code, `admin/${path}`).toBe('FORBIDDEN');
    }
  });

  it('admin.enabled: false → still 403', async () => {
    await boot([...BASE_CONFIG, 'admin.enabled: false']);
    const res = await rpcPost('getStatus', {});
    expect(res.status).toBe(403);
  });

  it('admin.enabled: true → getStatus works', async () => {
    await boot([...BASE_CONFIG, 'admin.enabled: true']);
    const res = await rpcPost('getStatus', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      json: { channels: unknown[]; providers: unknown[]; mcpServers: unknown[] };
    };
    expect(Array.isArray(body.json.channels)).toBe(true);
    expect(Array.isArray(body.json.providers)).toBe(true);
    expect(Array.isArray(body.json.mcpServers)).toBe(true);
  });

  it('testSend on an unconfigured channel → honest not-configured error', async () => {
    await boot([...BASE_CONFIG, 'admin.enabled: true']);
    const res = await rpcPost('testSend', { channel: 'telegram' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { ok: boolean; error?: string } };
    expect(body.json.ok).toBe(false);
    expect(body.json.error).toContain('not configured');
  });

  it('testSend on a configured channel → honest no-transport error', async () => {
    await boot([...BASE_CONFIG, 'telegramToken: 1234:ABCDEF', 'admin.enabled: true']);
    const res = await rpcPost('testSend', { channel: 'telegram' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { ok: boolean; error?: string } };
    expect(body.json.ok).toBe(false);
    expect(body.json.error).toContain('No channel transport');
  });
});

describe('admin.checkProvider — resolved key reaches the validator', () => {
  function makeContext(overrides: {
    creds: { apiKey: string; baseUrl?: string } | null;
    onValidate: (input: ValidateProviderInput) => void;
  }): RpcContext {
    const stub = {
      config: {
        adminEnabled: async () => true,
        resolveProviderCredentials: async () => overrides.creds,
      },
      onboarding: {
        validateProvider: async (input: ValidateProviderInput) => {
          overrides.onValidate(input);
          return { ok: true, models: [], error: null, completionTested: true };
        },
      },
    };
    // Cast: the handler only touches `config` and `onboarding`; the full
    // RpcContext would drag in every service for a unit-level test.
    return stub as unknown as RpcContext;
  }

  it('passes the resolved stored key (and baseUrl) to validateProvider', async () => {
    const seen: ValidateProviderInput[] = [];
    const context = makeContext({
      creds: { apiKey: 'sk-resolved-key', baseUrl: 'https://example.com/v1' },
      onValidate: (input) => seen.push(input),
    });
    const result = await call(adminRouter.checkProvider, { provider: 'openai' }, { context });
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.apiKey).toBe('sk-resolved-key');
    expect(seen[0]?.baseUrl).toBe('https://example.com/v1');
  });

  it('returns ok:false without probing when the provider is not configured', async () => {
    const seen: ValidateProviderInput[] = [];
    const context = makeContext({ creds: null, onValidate: (input) => seen.push(input) });
    const result = await call(adminRouter.checkProvider, { provider: 'openai' }, { context });
    expect(result.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });
});

describe('ConfigService — adminEnabled + resolveProviderCredentials', () => {
  async function makeService(
    yaml: string,
    secretValues: Record<string, string> = {},
  ): Promise<ConfigService> {
    const storage = new InMemoryStorage();
    const dataDir = '/data';
    const secrets: SecretsResolver = {
      get: async (ref) => secretValues[ref] ?? null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    };
    const repo = new ConfigRepository({ dataDir, storage, secrets });
    await storage.mkdir(dataDir);
    await storage.write(join(dataDir, 'config.yaml'), yaml);
    return new ConfigService({ config: repo, secrets });
  }

  it('adminEnabled is false by default and true only with admin.enabled: true', async () => {
    const off = await makeService('provider: anthropic\napiKey: sk-x\n');
    expect(await off.adminEnabled()).toBe(false);

    const on = await makeService('provider: anthropic\napiKey: sk-x\nadmin.enabled: true\n');
    expect(await on.adminEnabled()).toBe(true);
  });

  it('get() reports adminEnabled from config (no longer hardcoded)', async () => {
    const service = await makeService('provider: anthropic\napiKey: sk-x\n');
    expect((await service.get()).adminEnabled).toBe(false);
  });

  it('resolves secret-ref indirection in stored provider keys', async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config syntax, not a template
    const service = await makeService('provider: anthropic\napiKey: "${secrets:anthropic/key}"\n', {
      'anthropic/key': 'sk-from-secrets',
    });
    const creds = await service.resolveProviderCredentials('anthropic');
    expect(creds?.apiKey).toBe('sk-from-secrets');
  });

  it('prefers the provider-chain entry over the primary fields', async () => {
    const service = await makeService(
      [
        'provider: anthropic',
        'apiKey: sk-primary',
        'providers.0.provider: openrouter',
        'providers.0.apiKey: sk-chain',
        'providers.0.baseUrl: https://openrouter.ai/api/v1',
      ].join('\n'),
    );
    const creds = await service.resolveProviderCredentials('openrouter');
    expect(creds).toEqual({ apiKey: 'sk-chain', baseUrl: 'https://openrouter.ai/api/v1' });
    const primary = await service.resolveProviderCredentials('anthropic');
    expect(primary?.apiKey).toBe('sk-primary');
  });

  it('returns null for an unconfigured provider', async () => {
    const service = await makeService('provider: anthropic\napiKey: sk-x\n');
    expect(await service.resolveProviderCredentials('ollama')).toBeNull();
  });
});
