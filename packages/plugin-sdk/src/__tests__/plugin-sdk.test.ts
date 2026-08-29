import {
  DefaultExecutionBackendRegistry,
  DefaultHookRegistry,
  DefaultLLMProviderRegistry,
  DefaultMemoryProviderRegistry,
  DefaultPersonalityRegistry,
  DefaultStorageRegistry,
  DefaultToolRegistry,
} from '@ethosagent/core';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import type { PluginRegistries } from '../index';
import { PluginApiImpl } from '../index';
import { createTestRuntime, mockLLM, mockTool } from '../testing';
import { defineTool, err, ok } from '../tool-helpers';

function makeRegistries(): PluginRegistries {
  const injectors: import('@ethosagent/types').ContextInjector[] = [];
  return {
    tools: new DefaultToolRegistry(),
    hooks: new DefaultHookRegistry(),
    injectors,
    injectorPluginIds: new Map<import('@ethosagent/types').ContextInjector, string>(),
    personalities: new DefaultPersonalityRegistry(),
    llmProviders: new DefaultLLMProviderRegistry(),
    memoryProviders: new DefaultMemoryProviderRegistry(),
    storageBackends: new DefaultStorageRegistry(),
    executionBackends: new DefaultExecutionBackendRegistry(),
    platformAdapters: new Map<string, import('@ethosagent/types').PlatformAdapterFactory>(),
  };
}

// ---------------------------------------------------------------------------
// tool-helpers
// ---------------------------------------------------------------------------

describe('ok / err', () => {
  it('ok returns success result', () => {
    const result = ok('hello');
    expect(result).toEqual({ ok: true, value: 'hello' });
  });

  it('err returns failure result with default code', () => {
    const result = err('something broke');
    expect(result).toEqual({ ok: false, error: 'something broke', code: 'execution_failed' });
  });

  it('err accepts explicit code', () => {
    const result = err('bad args', 'input_invalid');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });
});

describe('defineTool', () => {
  it('returns a valid Tool object', () => {
    const tool = defineTool<{ query: string }>({
      name: 'test_tool',
      description: 'A test tool',
      schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      async execute({ query }) {
        return ok(`Result: ${query}`);
      },
    });

    expect(tool.name).toBe('test_tool');
    expect(tool.description).toBe('A test tool');
  });
});

// ---------------------------------------------------------------------------
// PluginApiImpl
// ---------------------------------------------------------------------------

describe('PluginApiImpl.registerTool', () => {
  it('registers tool into tool registry', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('test-plugin', registries);

    api.registerTool(mockTool('my_tool', 'result'));

    expect(registries.tools.get('my_tool')).toBeDefined();
    expect(registries.tools.getAvailable().map((t) => t.name)).toContain('my_tool');
  });

  it('cleanup removes the registered tool', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('test-plugin', registries);

    api.registerTool(mockTool('my_tool', 'result'));
    expect(registries.tools.get('my_tool')).toBeDefined();

    api.cleanup();
    expect(registries.tools.get('my_tool')).toBeUndefined();
  });
});

describe('PluginApiImpl.registerVoidHook', () => {
  it('registers a void hook that fires', async () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('test-plugin', registries);

    let fired = false;
    api.registerVoidHook('agent_done', async () => {
      fired = true;
    });

    await registries.hooks.fireVoid(
      'agent_done',
      {
        sessionId: 'test',
        text: 'hello',
        turnCount: 1,
      },
      ['test-plugin'],
    );

    expect(fired).toBe(true);
  });

  it('cleanup removes the hook', async () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('test-plugin', registries);

    let fired = false;
    api.registerVoidHook('agent_done', async () => {
      fired = true;
    });

    api.cleanup();

    await registries.hooks.fireVoid('agent_done', {
      sessionId: 'test',
      text: 'hello',
      turnCount: 1,
    });

    expect(fired).toBe(false);
  });
});

describe('PluginApiImpl.registerInjector', () => {
  it('adds injector to the shared array', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('test-plugin', registries);

    const injector: import('@ethosagent/types').ContextInjector = {
      id: 'test',
      priority: 50,
      async inject() {
        return { content: 'test content', position: 'append' };
      },
    };

    api.registerInjector(injector);
    expect(registries.injectors).toContain(injector);
  });

  it('cleanup removes the injector from the shared array', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('test-plugin', registries);

    const injector: import('@ethosagent/types').ContextInjector = {
      id: 'test',
      priority: 50,
      async inject() {
        return null;
      },
    };

    api.registerInjector(injector);
    api.cleanup();
    expect(registries.injectors).not.toContain(injector);
  });

  it('registerInjector records provenance in injectorPluginIds', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('my-plugin', registries);

    const injector: import('@ethosagent/types').ContextInjector = {
      id: 'test',
      priority: 50,
      async inject() {
        return null;
      },
    };

    api.registerInjector(injector);
    expect(registries.injectorPluginIds.get(injector)).toBe('my-plugin');
  });

  it('cleanup removes injector from injectorPluginIds', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('my-plugin', registries);

    const injector: import('@ethosagent/types').ContextInjector = {
      id: 'test',
      priority: 50,
      async inject() {
        return null;
      },
    };

    api.registerInjector(injector);
    api.cleanup();
    expect(registries.injectorPluginIds.has(injector)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// testing utilities
// ---------------------------------------------------------------------------

describe('mockLLM', () => {
  it('streams the given response', async () => {
    const llm = mockLLM(['Hello world']);
    const chunks: string[] = [];

    for await (const chunk of llm.complete([], [], {})) {
      if (chunk.type === 'text_delta') chunks.push(chunk.text);
    }

    expect(chunks.join('')).toBe('Hello world');
  });

  it('cycles through responses', async () => {
    const llm = mockLLM(['First', 'Second']);
    const collect = async () => {
      const chunks: string[] = [];
      for await (const chunk of llm.complete([], [], {})) {
        if (chunk.type === 'text_delta') chunks.push(chunk.text);
      }
      return chunks.join('');
    };

    expect(await collect()).toBe('First');
    expect(await collect()).toBe('Second');
    expect(await collect()).toBe('First'); // wraps
  });
});

describe('mockTool', () => {
  it('returns fixed string result', async () => {
    const tool = mockTool('search', 'found results');
    const ctx = {
      sessionId: 'test',
      sessionKey: 'cli:test',
      platform: 'cli',
      workingDir: '/tmp',
      currentTurn: 1,
      messageCount: 1,
      abortSignal: new AbortController().signal,
      emit: () => {},
      resultBudgetChars: 80_000,
    };
    const result = await tool.execute({}, ctx);
    expect(result).toEqual({ ok: true, value: 'found results' });
  });

  it('accepts ToolResult directly', async () => {
    const tool = mockTool('bad', { ok: false, error: 'nope', code: 'not_available' });
    const ctx = {
      sessionId: 'test',
      sessionKey: 'cli:test',
      platform: 'cli',
      workingDir: '/tmp',
      currentTurn: 1,
      messageCount: 1,
      abortSignal: new AbortController().signal,
      emit: () => {},
      resultBudgetChars: 80_000,
    };
    const result = await tool.execute({}, ctx);
    expect(result.ok).toBe(false);
  });
});

describe('createTestRuntime', () => {
  it('creates an AgentLoop that emits done', async () => {
    const loop = createTestRuntime({ llm: mockLLM(['Hi!']) });
    const events: string[] = [];

    for await (const event of loop.run('hello')) {
      events.push(event.type);
    }

    expect(events).toContain('text_delta');
    expect(events).toContain('done');
  });
});

// ---------------------------------------------------------------------------
// Data source registration
// ---------------------------------------------------------------------------

describe('PluginApiImpl.registerDataSource', () => {
  it('registers a data source path', () => {
    const registries = makeRegistries();
    registries.dataSources = new Map();
    const api = new PluginApiImpl('test-plugin', registries);
    api.registerDataSource('my-db', '/data/test.db');

    const pluginSources = registries.dataSources.get('test-plugin');
    expect(pluginSources?.get('my-db')).toBe('/data/test.db');
  });

  it('cleanup removes data sources', () => {
    const registries = makeRegistries();
    registries.dataSources = new Map();
    const api = new PluginApiImpl('test-plugin', registries);
    api.registerDataSource('my-db', '/data/test.db');

    api.cleanup();
    expect(registries.dataSources.get('test-plugin')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Provider registration (Phase 3 — plugin providers)
// ---------------------------------------------------------------------------

describe('PluginApiImpl.registerLLMProvider', () => {
  it('registers a factory into the LLM registry with plugin-id prefix', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('my-plugin', registries);
    const factory = () => mockLLM(['test']);
    api.registerLLMProvider('custom-model', factory);
    expect(registries.llmProviders.get('my-plugin/custom-model')).toBe(factory);
  });

  it('accepts pre-qualified name with matching prefix', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('my-plugin', registries);
    const factory = () => mockLLM(['test']);
    api.registerLLMProvider('my-plugin/custom-model', factory);
    expect(registries.llmProviders.get('my-plugin/custom-model')).toBe(factory);
  });

  it('rejects pre-qualified name with wrong prefix', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('my-plugin', registries);
    expect(() => api.registerLLMProvider('other-plugin/model', () => mockLLM(['x']))).toThrow(
      /cannot register LLM provider/,
    );
  });

  it('cleanup unregisters the provider and re-registration does not throw', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('my-plugin', registries);
    const factory = () => mockLLM(['test']);
    api.registerLLMProvider('custom-model', factory);
    expect(registries.llmProviders.get('my-plugin/custom-model')).toBe(factory);
    api.cleanup();
    expect(registries.llmProviders.get('my-plugin/custom-model')).toBeUndefined();
    const api2 = new PluginApiImpl('my-plugin', registries);
    expect(() => api2.registerLLMProvider('custom-model', factory)).not.toThrow();
  });
});

describe('PluginApiImpl.registerMemoryProvider', () => {
  it('registers a factory into the memory registry with plugin-id prefix', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('mem-plugin', registries);
    const factory = () => ({}) as unknown as import('@ethosagent/types').MemoryProvider;
    api.registerMemoryProvider('custom-backend', factory);
    expect(registries.memoryProviders.get('mem-plugin/custom-backend')).toBe(factory);
  });

  it('rejects pre-qualified name with wrong prefix', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('mem-plugin', registries);
    const factory = () => ({}) as unknown as import('@ethosagent/types').MemoryProvider;
    expect(() => api.registerMemoryProvider('other/backend', factory)).toThrow(
      /cannot register memory provider/,
    );
  });

  it('cleanup unregisters the memory provider and re-registration does not throw', () => {
    const registries = makeRegistries();
    const api = new PluginApiImpl('mem-plugin', registries);
    const factory = () => ({}) as unknown as import('@ethosagent/types').MemoryProvider;
    api.registerMemoryProvider('custom-backend', factory);
    expect(registries.memoryProviders.get('mem-plugin/custom-backend')).toBe(factory);
    api.cleanup();
    expect(registries.memoryProviders.get('mem-plugin/custom-backend')).toBeUndefined();
    const api2 = new PluginApiImpl('mem-plugin', registries);
    expect(() => api2.registerMemoryProvider('custom-backend', factory)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Credential methods
// ---------------------------------------------------------------------------

async function makeCredentialApi(
  opts: { pluginId?: string; secrets?: InMemorySecretsResolver } = {},
): Promise<{ api: PluginApiImpl; storage: InMemoryStorage; secrets: InMemorySecretsResolver }> {
  const storage = new InMemoryStorage();
  await storage.mkdir('/test');
  await storage.mkdir('/test/credentials');
  const secrets = opts.secrets ?? new InMemorySecretsResolver();
  const api = new PluginApiImpl(opts.pluginId ?? 'test-plugin', makeRegistries(), {
    secrets,
    storage,
    basePath: '/test',
  });
  await api.primeSecrets();
  return { api, storage, secrets };
}

describe('credential methods', () => {
  it('hasSecret returns false before setSecret, true after', async () => {
    const { api } = await makeCredentialApi();
    expect(api.hasSecret('api-key')).toBe(false);
    await api.setSecret('api-key', 'sk-123');
    expect(api.hasSecret('api-key')).toBe(true);
  });

  it('getSecret returns null before setSecret, the value after', async () => {
    const { api } = await makeCredentialApi();
    expect(await api.getSecret('token')).toBeNull();
    await api.setSecret('token', 'abc');
    expect(await api.getSecret('token')).toBe('abc');
  });

  it('setSecret puts the value in the vault and writes only a .meta file to storage', async () => {
    // G-SEC — the SecretsResolver is the sole storage path for the value. The
    // assertion is on what reached storage, not on what the api returns: a
    // check that only round-trips through getSecret passes against the old
    // implementation that wrote plaintext to `<basePath>/credentials/<key>`.
    const { api, storage, secrets } = await makeCredentialApi();
    await api.setSecret('db-pass', 's3cret');

    expect(await secrets.get('plugins/test-plugin/db-pass')).toBe('s3cret');
    expect(await storage.exists('/test/credentials/db-pass')).toBe(false);

    const meta = await storage.read('/test/credentials/db-pass.meta');
    expect(meta).not.toBeNull();
    const parsed = JSON.parse(meta as string);
    expect(parsed.updatedAt).toBeDefined();
    expect(typeof parsed.updatedAt).toBe('string');
  });

  it('setSecret writes the meta file owner-only, and locks the directory', async () => {
    const { api, storage } = await makeCredentialApi();
    await api.setSecret('db-pass', 's3cret');

    expect(storage.getMode('/test/credentials/db-pass.meta')).toBe(0o600);
    expect(storage.getDirMode('/test/credentials')).toBe(0o700);
  });

  it('primeSecrets makes a pre-existing vault entry visible to the first hasSecret', async () => {
    const secrets = new InMemorySecretsResolver();
    await secrets.set('plugins/test-plugin/seeded', 'from-a-previous-run');
    const { api } = await makeCredentialApi({ secrets });

    expect(api.hasSecret('seeded')).toBe(true);
    expect(await api.getSecret('seeded')).toBe('from-a-previous-run');
  });

  it('rejects a traversal-shaped key without writing anything', async () => {
    const { api, secrets } = await makeCredentialApi();

    await expect(api.setSecret('../../evil', 'x')).rejects.toThrow(/Invalid credential key/);
    await expect(api.getSecret('../../evil')).rejects.toThrow(/Invalid credential key/);
    expect(api.hasSecret('../../evil')).toBe(false);
    // Refused before the write, not routed somewhere else.
    expect(await secrets.list()).toEqual([]);
  });

  it('one plugin cannot read a sibling plugin secret through its own prefix', async () => {
    const secrets = new InMemorySecretsResolver();
    const { api: alice } = await makeCredentialApi({ pluginId: 'alice', secrets });
    const { api: bob } = await makeCredentialApi({ pluginId: 'bob', secrets });

    await alice.setSecret('token', 'alice-token');
    await bob.primeSecrets();

    expect(bob.hasSecret('token')).toBe(false);
    expect(await bob.getSecret('token')).toBeNull();
    expect(await secrets.list('plugins/alice/')).toEqual(['plugins/alice/token']);
  });

  it('setSecret fires onCredentialUpdate handlers', async () => {
    const { api } = await makeCredentialApi();
    const updates: string[] = [];
    api.onCredentialUpdate(async (key) => {
      updates.push(key);
    });

    await api.setSecret('key1', 'val1');
    await api.setSecret('key2', 'val2');
    expect(updates).toEqual(['key1', 'key2']);
  });

  it('onCredentialUpdate returns working unsubscribe function', async () => {
    const { api } = await makeCredentialApi();
    const updates: string[] = [];
    const unsub = api.onCredentialUpdate(async (key) => {
      updates.push(key);
    });

    await api.setSecret('a', '1');
    unsub();
    await api.setSecret('b', '2');

    expect(updates).toEqual(['a']);
  });

  it('cleanup clears credential update handlers', async () => {
    const { api } = await makeCredentialApi();
    const updates: string[] = [];
    api.onCredentialUpdate(async (key) => {
      updates.push(key);
    });

    await api.setSecret('before', 'x');
    api.cleanup();
    await api.setSecret('after', 'y');

    expect(updates).toEqual(['before']);
  });

  it('hasSecret/getSecret return false/null when no credential storage configured', async () => {
    const api = new PluginApiImpl('no-creds', makeRegistries());
    expect(api.hasSecret('anything')).toBe(false);
    expect(await api.getSecret('anything')).toBeNull();
  });

  it('setSecret throws when no credential storage configured', async () => {
    const api = new PluginApiImpl('no-creds', makeRegistries());
    await expect(api.setSecret('key', 'val')).rejects.toThrow(/no credential storage configured/);
  });
});
