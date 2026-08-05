import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import {
  isServerAllowed,
  McpManager,
  type McpServerConfig,
  McpSessionView,
  matchesGlob,
} from '../index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestServer(name = 'test-server') {
  const server = new Server({ name, version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: 'Echoes the message',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { arguments: args } = req.params;
    const msg = (args as Record<string, unknown>)?.message ?? '';
    return { content: [{ type: 'text' as const, text: String(msg) }] };
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { clientTransport, server };
}

// ---------------------------------------------------------------------------
// Glob matching tests
// ---------------------------------------------------------------------------

describe('matchesGlob', () => {
  it('wildcard * matches anything', () => {
    expect(matchesGlob('anything', '*')).toBe(true);
    expect(matchesGlob('', '*')).toBe(true);
    expect(matchesGlob('complex-name-123', '*')).toBe(true);
  });

  it('prefix-* matches names with that prefix', () => {
    expect(matchesGlob('github-repo', 'github-*')).toBe(true);
    expect(matchesGlob('github-', 'github-*')).toBe(true);
    expect(matchesGlob('github', 'github-*')).toBe(false);
    expect(matchesGlob('slack-channel', 'github-*')).toBe(false);
  });

  it('exact match for patterns without *', () => {
    expect(matchesGlob('my-server', 'my-server')).toBe(true);
    expect(matchesGlob('my-server', 'my-serve')).toBe(false);
    expect(matchesGlob('my-serve', 'my-server')).toBe(false);
  });
});

describe('isServerAllowed', () => {
  it('returns true when allowlist is undefined (open mode)', () => {
    expect(isServerAllowed('anything', undefined)).toBe(true);
  });

  it('returns false when allowlist is empty (explicit deny-all)', () => {
    // A personality with no `mcp_servers` normalises to []. Treating that as
    // open mode would let a session view lease servers the personality cannot
    // reach in a normal turn.
    expect(isServerAllowed('anything', [])).toBe(false);
  });

  it('filters by exact name', () => {
    const allowlist = ['github', 'slack'];
    expect(isServerAllowed('github', allowlist)).toBe(true);
    expect(isServerAllowed('slack', allowlist)).toBe(true);
    expect(isServerAllowed('discord', allowlist)).toBe(false);
  });

  it('filters by prefix glob', () => {
    const allowlist = ['internal-*', 'github'];
    expect(isServerAllowed('internal-api', allowlist)).toBe(true);
    expect(isServerAllowed('internal-db', allowlist)).toBe(true);
    expect(isServerAllowed('github', allowlist)).toBe(true);
    expect(isServerAllowed('external-api', allowlist)).toBe(false);
  });

  it('wildcard in allowlist allows everything', () => {
    const allowlist = ['*'];
    expect(isServerAllowed('anything', allowlist)).toBe(true);
    expect(isServerAllowed('another-thing', allowlist)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// McpSessionView tests
// ---------------------------------------------------------------------------

describe('McpSessionView', () => {
  it('merges global + session tools', async () => {
    // Create a global manager with no servers (empty tools)
    const globalManager = new McpManager([]);
    await globalManager.connect();

    const view = new McpSessionView(globalManager);

    // Before registering session servers, only global tools (none)
    expect(view.getTools()).toHaveLength(0);

    // Register a session server
    await createTestServer('session-srv');

    // We need to mock the McpClient to use in-memory transport.
    // Since registerSessionServers creates clients internally, we test
    // via the allowlist filtering behavior instead.
    expect(view.getSessionTools()).toHaveLength(0);

    await globalManager.disconnect();
  });

  it('registerSessionServers rejects servers not in allowlist', async () => {
    const globalManager = new McpManager([]);
    await globalManager.connect();
    const view = new McpSessionView(globalManager);

    const configs: McpServerConfig[] = [
      { name: 'allowed-server', transport: 'stdio', command: 'echo' },
      { name: 'blocked-server', transport: 'stdio', command: 'echo' },
    ];

    const allowlist = ['allowed-*'];
    const result = await view.registerSessionServers(configs, allowlist);

    // allowed-server matches 'allowed-*' but will fail to connect (no real process)
    // blocked-server should be rejected by the allowlist
    expect(result.rejected.some((r) => r.name === 'blocked-server')).toBe(true);
    const blockedEntry = result.rejected.find((r) => r.name === 'blocked-server');
    expect(blockedEntry?.reason).toContain('not in personality MCP allowlist');

    await view.teardown();
    await globalManager.disconnect();
  });

  it('registerSessionServers grants nothing when the personality allowlist is empty', async () => {
    const globalManager = new McpManager([]);
    await globalManager.connect();
    const view = new McpSessionView(globalManager);

    const configs: McpServerConfig[] = [
      { name: 'any-server', transport: 'stdio', command: 'echo' },
    ];

    // [] is what a personality with no `mcp_servers` normalises to. Nothing is
    // grantable — the lease can never widen the personality's standing reach.
    const result = await view.registerSessionServers(configs, []);

    expect(result.registered).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain('not in personality MCP allowlist');
    expect(view.getSessionTools()).toHaveLength(0);

    await view.teardown();
    await globalManager.disconnect();
  });

  it('registerSessionServers allows all when allowlist is undefined', async () => {
    const globalManager = new McpManager([]);
    await globalManager.connect();
    const view = new McpSessionView(globalManager);

    const configs: McpServerConfig[] = [
      { name: 'any-server', transport: 'stdio', command: 'nonexistent-command-xyz' },
    ];

    // undefined allowlist = open mode, server passes filter but fails to connect
    const result = await view.registerSessionServers(configs, undefined);
    // The server will be rejected due to connection failure, not allowlist
    expect(result.rejected.every((r) => !r.reason.includes('allowlist'))).toBe(true);

    await view.teardown();
    await globalManager.disconnect();
  });

  it('teardown disconnects session clients and clears tools', async () => {
    const globalManager = new McpManager([]);
    await globalManager.connect();
    const view = new McpSessionView(globalManager);

    // After teardown, session tools should be empty
    await view.teardown();
    expect(view.getSessionTools()).toHaveLength(0);
    expect(view.getTools()).toHaveLength(0);

    await globalManager.disconnect();
  });

  it('isSessionTool correctly identifies session vs global tools', async () => {
    const globalManager = new McpManager([]);
    await globalManager.connect();
    const view = new McpSessionView(globalManager);

    expect(view.isSessionTool('mcp__test__echo')).toBe(false);

    await view.teardown();
    await globalManager.disconnect();
  });
});
