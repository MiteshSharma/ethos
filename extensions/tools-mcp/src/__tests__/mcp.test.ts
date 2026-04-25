import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { McpClient, McpManager } from '../index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a low-level MCP Server with one 'echo' tool and one 'fail' tool,
 * connects it to an in-memory transport pair, and returns the client-side transport.
 */
async function createTestServer(opts?: { onCallTool?: () => void }) {
  const server = new Server(
    { name: 'test-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: 'Echoes the message argument',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
      },
      {
        name: 'fail',
        description: 'Always returns an error',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    opts?.onCallTool?.();
    const { name, arguments: args } = req.params;
    if (name === 'echo') {
      const msg = (args as Record<string, unknown>)?.message ?? '';
      return { content: [{ type: 'text' as const, text: String(msg) }] };
    }
    if (name === 'fail') {
      return { content: [{ type: 'text' as const, text: 'intentional error' }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: 'unknown tool' }], isError: true };
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { clientTransport, server };
}

/**
 * McpClient that bypasses real transport creation and uses the provided in-memory transport.
 */
class TestMcpClient extends McpClient {
  private _transport: InstanceType<typeof InMemoryTransport>;

  constructor(transport: InstanceType<typeof InMemoryTransport>, name = 'test') {
    super({ name, transport: 'stdio', command: 'unused' });
    this._transport = transport;
  }

  // biome-ignore lint/suspicious/noExplicitAny: override for test
  protected override async _createTransport(): Promise<any> {
    return this._transport;
  }
}

// ---------------------------------------------------------------------------
// McpClient tests
// ---------------------------------------------------------------------------

describe('McpClient', () => {
  it('connects and lists tools', async () => {
    const { clientTransport } = await createTestServer();
    const client = new TestMcpClient(clientTransport);
    await client.connect();

    expect(client.isConnected()).toBe(true);
    const tools = await client.listTools();
    expect(tools).toHaveLength(2);
    expect(tools[0]?.name).toBe('echo');
    expect(tools[1]?.name).toBe('fail');

    await client.disconnect();
  });

  it('callTool returns ok:true with text content', async () => {
    const { clientTransport } = await createTestServer();
    const client = new TestMcpClient(clientTransport);
    await client.connect();

    const result = await client.callTool('echo', { message: 'hello' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('hello');

    await client.disconnect();
  });

  it('callTool returns ok:false when server returns isError:true', async () => {
    const { clientTransport } = await createTestServer();
    const client = new TestMcpClient(clientTransport);
    await client.connect();

    const result = await client.callTool('fail', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toBe('intentional error');
    }

    await client.disconnect();
  });

  it('callTool returns not_available when disconnected', async () => {
    const { clientTransport } = await createTestServer();
    const client = new TestMcpClient(clientTransport);
    // Never call connect()

    const result = await client.callTool('echo', { message: 'hi' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });

  it('in-flight callTool resolves with error on server close', async () => {
    let resolveOnCall!: () => void;
    const onCallTool = () => resolveOnCall?.();

    const { clientTransport, server } = await createTestServer({ onCallTool });

    // Patch: close the server after the handler is invoked but before it responds.
    // We do this by making the handler block on a promise we control.
    let blockResolve!: () => void;
    const blocked = new Promise<void>((resolve) => {
      blockResolve = resolve;
    });

    // Override handler to block until we release it
    server.setRequestHandler(CallToolRequestSchema, async () => {
      resolveOnCall?.();
      await blocked;
      return { content: [{ type: 'text' as const, text: 'late response' }] };
    });

    const client = new TestMcpClient(clientTransport);
    await client.connect();

    const callPromise = client.callTool('echo', { message: 'test' });

    // Wait until server handler has started (call has arrived)
    await new Promise<void>((resolve) => {
      resolveOnCall = resolve;
    });

    // Close the server — this should trigger the client's onclose
    await server.close();

    // Unblock the handler (doesn't matter, client is already gone)
    blockResolve();

    const result = await callPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['execution_failed', 'not_available']).toContain(result.code);
    }
  });
});

// ---------------------------------------------------------------------------
// McpManager tests
// ---------------------------------------------------------------------------

describe('McpManager', () => {
  it('getTools returns Tool[] adapters for all discovered tools', async () => {
    const { clientTransport } = await createTestServer();

    // Patch McpClient factory on McpManager using subclass
    class TestManager extends McpManager {
      constructor() {
        super([{ name: 'test', transport: 'stdio', command: 'unused' }]);
        // Replace the internal client with our test client
        // biome-ignore lint/suspicious/noExplicitAny: access private for test
        (this as any)._clients = [new TestMcpClient(clientTransport)];
      }
    }

    const manager = new TestManager();
    await manager.connect();

    const tools = manager.getTools();
    expect(tools.length).toBeGreaterThanOrEqual(2);
    expect(tools.map((t) => t.name)).toContain('mcp__test__echo');
    expect(tools.map((t) => t.name)).toContain('mcp__test__fail');

    await manager.disconnect();
  });

  it('Tool adapter execute calls through to McpClient', async () => {
    const { clientTransport } = await createTestServer();

    class TestManager extends McpManager {
      constructor() {
        super([{ name: 'srv', transport: 'stdio', command: 'unused' }]);
        // biome-ignore lint/suspicious/noExplicitAny: access private for test
        (this as any)._clients = [new TestMcpClient(clientTransport, 'srv')];
      }
    }

    const manager = new TestManager();
    await manager.connect();

    const echoTool = manager.getTools().find((t) => t.name === 'mcp__srv__echo');
    expect(echoTool).toBeDefined();

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

    const result = await echoTool!.execute({ message: 'world' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('world');

    await manager.disconnect();
  });

  it('isAvailable() reflects connection state', async () => {
    const { clientTransport } = await createTestServer();

    class TestManager extends McpManager {
      constructor() {
        super([{ name: 'test', transport: 'stdio', command: 'unused' }]);
        // biome-ignore lint/suspicious/noExplicitAny: access private for test
        (this as any)._clients = [new TestMcpClient(clientTransport)];
      }
    }

    const manager = new TestManager();
    await manager.connect();

    const tool = manager.getTools()[0];
    expect(tool?.isAvailable?.()).toBe(true);

    await manager.disconnect();
    expect(tool?.isAvailable?.()).toBe(false);
  });

  it('handles empty config gracefully', async () => {
    const manager = new McpManager([]);
    await manager.connect();
    expect(manager.getTools()).toHaveLength(0);
    await manager.disconnect();
  });
});
