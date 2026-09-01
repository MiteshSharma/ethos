import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { type McpInstallFlow, McpJsonStore, type McpManager } from '@ethosagent/tools-mcp';
import { describe, expect, it, vi } from 'vitest';
import { McpService } from '../../services/mcp.service';

// Narrowly scoped — the only behavior under test is that McpService.start
// threads its second argument (the per-request redirect URI derived from
// the web request's Origin) through to the underlying McpInstallFlow.start
// call. Full happy-path / error-path coverage of the install flow lives in
// extensions/tools-mcp/src/__tests__/install-flow.test.ts.

describe('McpService.start — redirectUri thread-through', () => {
  function makeServiceWithSpy() {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    const mcpJsonStore = new McpJsonStore(storage);
    const mcpManager: McpManager = {
      connect: async () => {},
      disconnect: async () => {},
      shutdown: async () => {},
      getTools: () => [],
      listServers: () => [],
      addServer: async () => {},
      removeServer: async () => {},
    } as unknown as McpManager;
    const personalityUpdater = {
      get: () => undefined,
      update: async () => undefined,
    };

    const service = new McpService({
      mcpManager,
      personalityUpdater,
      secrets,
      mcpJsonStore,
      redirectUri: 'http://default.fallback/oauth/callback',
    });

    // Reach in and stub the private `flow` so we can observe the args
    // passed to `start()`. Replacing the field directly avoids the cost
    // of mocking discovery + DCR fetch calls — the test is about the
    // thread-through wiring, not the flow's own behavior.
    const flowStart = vi.fn(async () => ({
      state: 'STATE',
      authorizeUrl: 'https://auth.example/authorize',
      serverName: 'example',
      expiresAt: new Date(),
    }));
    (service as unknown as { flow: Pick<McpInstallFlow, 'start'> }).flow = {
      start: flowStart as unknown as McpInstallFlow['start'],
    };

    return { service, flowStart };
  }

  it('passes the per-call redirectUri to flow.start when supplied', async () => {
    const { service, flowStart } = makeServiceWithSpy();

    const result = await service.start(
      { url: 'https://mcp.example/sse', name: 'example', personalityId: 'p1' },
      'http://192.168.1.10:5173/oauth/callback',
    );

    expect(result.ok).toBe(true);
    expect(flowStart).toHaveBeenCalledTimes(1);
    const args = flowStart.mock.calls[0] as unknown[] | undefined;
    expect(args?.[0]).toEqual({
      mcpUrl: 'https://mcp.example/sse',
      name: 'example',
      personalityId: 'p1',
      redirectUri: 'http://192.168.1.10:5173/oauth/callback',
    });
  });

  it('omits redirectUri from the call when none is supplied (constructor default applies)', async () => {
    const { service, flowStart } = makeServiceWithSpy();

    const result = await service.start({
      url: 'https://mcp.example/sse',
      personalityId: 'p1',
    });

    expect(result.ok).toBe(true);
    expect(flowStart).toHaveBeenCalledTimes(1);
    const args = flowStart.mock.calls[0] as unknown[] | undefined;
    const arg = args?.[0] as Record<string, unknown> | undefined;
    expect(arg?.mcpUrl).toBe('https://mcp.example/sse');
    expect(arg?.personalityId).toBe('p1');
    expect(arg).not.toHaveProperty('redirectUri');
    expect(arg).not.toHaveProperty('name');
  });
});

describe('McpService.serverTools — per-server tool discovery', () => {
  function makeService(getToolsForPersonality: McpManager['getToolsForPersonality']): McpService {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    const mcpJsonStore = new McpJsonStore(storage);
    const mcpManager: McpManager = {
      connect: async () => {},
      disconnect: async () => {},
      shutdown: async () => {},
      getTools: () => [],
      getToolsForPersonality,
      listServers: () => [],
      addServer: async () => {},
      removeServer: async () => {},
    } as unknown as McpManager;
    return new McpService({
      mcpManager,
      personalityUpdater: { get: () => undefined, update: async () => undefined },
      secrets,
      mcpJsonStore,
      redirectUri: 'http://default.fallback/oauth/callback',
    });
  }

  // Minimal Tool-shaped object — only `name` and `description` are read.
  function tool(name: string, description?: string) {
    return { name, description } as unknown as Awaited<
      ReturnType<McpManager['getToolsForPersonality']>
    >[number];
  }

  it('strips the mcp__<server>__ prefix and returns only the named server', async () => {
    const service = makeService(async () => [
      tool('mcp__linear__list_issues', 'List issues'),
      tool('mcp__linear__get_issue', 'Get an issue'),
      tool('mcp__slack__search_public', 'Search'),
    ]);

    const result = await service.serverTools({ personalityId: 'p1', serverName: 'linear' });

    expect(result.available).toBe(true);
    expect(result.tools).toEqual([
      { name: 'list_issues', description: 'List issues' },
      { name: 'get_issue', description: 'Get an issue' },
    ]);
  });

  it('omits a description equal to the bare tool name', async () => {
    const service = makeService(async () => [tool('mcp__linear__list_issues', 'list_issues')]);
    const result = await service.serverTools({ personalityId: 'p1', serverName: 'linear' });
    expect(result.tools).toEqual([{ name: 'list_issues' }]);
  });

  it('returns available:false with no tools when the server exposed nothing', async () => {
    const service = makeService(async () => [tool('mcp__other__x')]);
    const result = await service.serverTools({ personalityId: 'p1', serverName: 'linear' });
    expect(result.available).toBe(false);
    expect(result.tools).toEqual([]);
  });

  it('returns available:false when discovery throws (server unreachable)', async () => {
    const service = makeService(async () => {
      throw new Error('connect failed');
    });
    const result = await service.serverTools({ personalityId: 'p1', serverName: 'linear' });
    expect(result.available).toBe(false);
    expect(result.tools).toEqual([]);
  });
});

describe('McpService.personalityServers', () => {
  async function makeServiceForPersonality(opts: {
    personality?: { id: string; mcp_servers?: string[] };
    configs?: Array<{
      name: string;
      transport: string;
      url?: string;
      auth?: { type: string };
    }>;
    secrets?: Record<string, string>;
  }): Promise<McpService> {
    const storage = new InMemoryStorage();
    const secretsResolver = new InMemorySecretsResolver();
    const mcpJsonStore = new McpJsonStore(storage);
    const mcpManager: McpManager = {
      connect: async () => {},
      disconnect: async () => {},
      shutdown: async () => {},
      getTools: () => [],
      listServers: () => [],
      addServer: async () => {},
      removeServer: async () => {},
    } as unknown as McpManager;

    const personalityUpdater = {
      get: (id: string) => {
        if (opts.personality && opts.personality.id === id) return opts.personality;
        return undefined;
      },
      update: async () => undefined,
    };

    // Seed configs before constructing the service.
    if (opts.configs) {
      for (const c of opts.configs) {
        await mcpJsonStore.upsert(c.name, c as never);
      }
    }

    // Seed secrets.
    if (opts.secrets) {
      for (const [key, value] of Object.entries(opts.secrets)) {
        await secretsResolver.set(key, value);
      }
    }

    return new McpService({
      mcpManager,
      personalityUpdater,
      secrets: secretsResolver,
      mcpJsonStore,
      redirectUri: 'http://test/callback',
    });
  }

  it('returns empty servers when personality is unknown', async () => {
    const service = await makeServiceForPersonality({});
    const result = await service.personalityServers({ personalityId: 'unknown' });
    expect(result.servers).toEqual([]);
  });

  it('returns authorized for non-OAuth servers', async () => {
    const service = await makeServiceForPersonality({
      personality: { id: 'p1', mcp_servers: ['stdio-server'] },
      configs: [{ name: 'stdio-server', transport: 'stdio' }],
    });
    const result = await service.personalityServers({ personalityId: 'p1' });
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]).toMatchObject({
      name: 'stdio-server',
      auth_status: 'authorized',
    });
  });

  it('returns missing when personality has no scoped tokens for an OAuth server', async () => {
    const service = await makeServiceForPersonality({
      personality: { id: 'p1', mcp_servers: ['oauth-srv'] },
      configs: [
        {
          name: 'oauth-srv',
          transport: 'streamable-http',
          url: 'https://mcp.example',
          auth: { type: 'oauth2' },
        },
      ],
    });
    const result = await service.personalityServers({ personalityId: 'p1' });
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]).toMatchObject({
      name: 'oauth-srv',
      auth_status: 'missing',
    });
  });

  it('returns authorized when personality has valid scoped tokens', async () => {
    const service = await makeServiceForPersonality({
      personality: { id: 'p1', mcp_servers: ['oauth-srv'] },
      configs: [
        {
          name: 'oauth-srv',
          transport: 'streamable-http',
          url: 'https://mcp.example',
          auth: { type: 'oauth2' },
        },
      ],
      secrets: {
        'personalities/p1/mcp/oauth-srv/access_token': 'tok_valid',
        'personalities/p1/mcp/oauth-srv/expires_at': String(Date.now() + 3600_000),
      },
    });
    const result = await service.personalityServers({ personalityId: 'p1' });
    expect(result.servers[0]).toMatchObject({
      name: 'oauth-srv',
      auth_status: 'authorized',
    });
  });

  it('returns expired when scoped token has passed its expires_at', async () => {
    const service = await makeServiceForPersonality({
      personality: { id: 'p1', mcp_servers: ['oauth-srv'] },
      configs: [
        {
          name: 'oauth-srv',
          transport: 'streamable-http',
          url: 'https://mcp.example',
          auth: { type: 'oauth2' },
        },
      ],
      secrets: {
        'personalities/p1/mcp/oauth-srv/access_token': 'tok_expired',
        'personalities/p1/mcp/oauth-srv/expires_at': String(Date.now() - 1000),
      },
    });
    const result = await service.personalityServers({ personalityId: 'p1' });
    expect(result.servers[0]).toMatchObject({
      name: 'oauth-srv',
      auth_status: 'expired',
    });
  });
});

describe('McpService.catalog', () => {
  function makeService(): McpService {
    const storage = new InMemoryStorage();
    const mcpManager = {} as unknown as McpManager;
    return new McpService({
      mcpManager,
      personalityUpdater: { get: () => undefined, update: async () => undefined },
      secrets: new InMemorySecretsResolver(),
      mcpJsonStore: new McpJsonStore(storage),
      redirectUri: 'http://localhost/oauth/callback',
    });
  }

  it('returns both preset arrays', () => {
    const catalog = makeService().catalog();
    expect(Array.isArray(catalog.remote)).toBe(true);
    expect(Array.isArray(catalog.local)).toBe(true);
  });

  it('includes linear in remote with its widened fields', () => {
    const linear = makeService()
      .catalog()
      .remote.find((p) => p.name === 'linear');
    expect(linear).toMatchObject({
      name: 'linear',
      label: 'Linear',
      url: 'https://mcp.linear.app/mcp',
      transport: 'streamable-http',
      authType: 'oauth',
      category: 'Productivity',
    });
    expect(linear?.description.length).toBeGreaterThan(0);
  });

  it('includes all four stdio presets in local, each with a category', () => {
    const local = makeService().catalog().local;
    const names = local.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['filesystem', 'git', 'fetch', 'memory']));
    // sqlite was removed from the preset table: archived upstream, Python-only,
    // and the npm package it named has never existed.
    expect(names).not.toContain('sqlite');
    for (const preset of local) {
      expect(preset.category.length).toBeGreaterThan(0);
    }
  });

  it('carries each preset argVars through to the browser', () => {
    const local = makeService().catalog().local;
    for (const preset of local) {
      expect(Array.isArray(preset.argVars)).toBe(true);
    }
    expect(local.find((p) => p.name === 'filesystem')?.argVars).toEqual(['ALLOWED_PATH']);
    expect(local.find((p) => p.name === 'memory')?.argVars).toEqual([]);
  });

  it('orders both arrays deterministically across calls', () => {
    const service = makeService();
    const first = service.catalog();
    const second = service.catalog();
    expect(first.remote.map((p) => p.name)).toEqual(second.remote.map((p) => p.name));
    expect(first.local.map((p) => p.name)).toEqual(second.local.map((p) => p.name));
    expect(first.local.map((p) => p.name)).toEqual([...first.local.map((p) => p.name)].sort());
  });
});
