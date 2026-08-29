import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerConfig } from '../index';
import { McpClient, McpManager } from '../index';

// ---------------------------------------------------------------------------
// Mock the MCP SDK
// ---------------------------------------------------------------------------

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockListTools = vi.fn().mockResolvedValue({ tools: [] });
const mockCallTool = vi.fn().mockResolvedValue({
  content: [{ type: 'text', text: 'ok' }],
});
const mockPing = vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/sdk/client', () => ({
  Client: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.connect = mockConnect;
    this.close = mockClose;
    this.listTools = mockListTools;
    this.callTool = mockCallTool;
    this.ping = mockPing;
    this.setNotificationHandler = vi.fn();
    this.onclose = null;
  }),
}));

const mockTransportClose = vi.fn().mockResolvedValue(undefined);
const mockProcessKill = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  // biome-ignore lint/complexity/useArrowFunction: must be callable with `new`
  StdioClientTransport: vi.fn().mockImplementation(function () {
    return {
      type: 'stdio-transport',
      close: mockTransportClose,
      _process: { kill: mockProcessKill },
    };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  // biome-ignore lint/complexity/useArrowFunction: must be callable with `new`
  SSEClientTransport: vi.fn().mockImplementation(function () {
    return { type: 'sse-transport' };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  ToolListChangedNotificationSchema: { method: 'notifications/tools/list_changed' },
}));

vi.mock('@ethosagent/safety-scanner', () => ({
  buildMcpEnv: vi.fn().mockReturnValue({ HOME: '/tmp', PATH: '/usr/bin' }),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP reliability bundle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    });
    mockPing.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 1.1 Keepalive ping + stale-pipe retry
  // -------------------------------------------------------------------------

  describe('keepalive ping', () => {
    it('starts keepalive interval after connect (default 30s)', async () => {
      const config: McpServerConfig = {
        name: 'srv',
        transport: 'stdio',
        command: 'node',
      };
      const client = new McpClient(config);
      await client.connect();

      expect(mockPing).not.toHaveBeenCalled();

      // Advance 30s — first ping fires
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockPing).toHaveBeenCalledTimes(1);

      // Advance another 30s
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockPing).toHaveBeenCalledTimes(2);

      await client.disconnect();
    });

    it('does not start keepalive when keepaliveSeconds is 0', async () => {
      const config: McpServerConfig = {
        name: 'srv',
        transport: 'stdio',
        command: 'node',
        keepaliveSeconds: 0,
      };
      const client = new McpClient(config);
      await client.connect();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockPing).not.toHaveBeenCalled();

      await client.disconnect();
    });

    it('uses custom keepaliveSeconds interval', async () => {
      const config: McpServerConfig = {
        name: 'srv',
        transport: 'stdio',
        command: 'node',
        keepaliveSeconds: 10,
      };
      const client = new McpClient(config);
      await client.connect();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockPing).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockPing).toHaveBeenCalledTimes(2);

      await client.disconnect();
    });

    it('triggers reconnect when ping fails', async () => {
      const config: McpServerConfig = {
        name: 'srv',
        transport: 'stdio',
        command: 'node',
        keepaliveSeconds: 5,
      };
      const client = new McpClient(config);
      await client.connect();
      expect(client.isConnected()).toBe(true);

      // Make ping fail
      mockPing.mockRejectedValueOnce(new Error('ping failed'));

      // Advance past the keepalive interval
      await vi.advanceTimersByTimeAsync(5_000);

      // Client should now be disconnected (reconnect scheduled)
      expect(client.isConnected()).toBe(false);

      await client.disconnect();
    });

    it('triggers reconnect when ping times out (5s)', async () => {
      const config: McpServerConfig = {
        name: 'srv',
        transport: 'stdio',
        command: 'node',
        keepaliveSeconds: 5,
      };
      const client = new McpClient(config);
      await client.connect();

      // Make ping never resolve
      mockPing.mockReturnValueOnce(new Promise(() => {}));

      // Advance past keepalive (5s) + ping timeout (5s)
      await vi.advanceTimersByTimeAsync(10_000);

      expect(client.isConnected()).toBe(false);

      await client.disconnect();
    });

    it('clears keepalive on disconnect', async () => {
      const config: McpServerConfig = {
        name: 'srv',
        transport: 'stdio',
        command: 'node',
        keepaliveSeconds: 5,
      };
      const client = new McpClient(config);
      await client.connect();
      await client.disconnect();

      // No pings should fire after disconnect
      mockPing.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockPing).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 1.2 Reload timeout on reconnect
  // -------------------------------------------------------------------------

  describe('connect timeout on reconnect', () => {
    it('times out reconnect after connectTimeoutMs and retries', async () => {
      const config: McpServerConfig = {
        name: 'srv',
        transport: 'stdio',
        command: 'node',
        keepaliveSeconds: 0,
        connectTimeoutMs: 500,
      };
      const client = new McpClient(config);

      // First connect succeeds
      await client.connect();
      expect(client.isConnected()).toBe(true);

      // Simulate disconnect via onclose
      const { Client } = await import('@modelcontextprotocol/sdk/client');
      const instances = vi.mocked(Client).mock.results;
      const sdkInstance = instances[instances.length - 1]?.value;
      if (sdkInstance?.onclose) sdkInstance.onclose();

      // Make next connect hang forever
      mockConnect.mockImplementationOnce(() => new Promise(() => {}));

      // Advance past reconnect delay (1s for attempt 0)
      await vi.advanceTimersByTimeAsync(1000);

      // Advance past the connect timeout (500ms)
      await vi.advanceTimersByTimeAsync(500);

      // Should schedule next reconnect (attempt 1, delay 2s)
      mockConnect.mockResolvedValueOnce(undefined);
      await vi.advanceTimersByTimeAsync(2000);

      // Multiple connect attempts should have been made
      expect(mockConnect.mock.calls.length).toBeGreaterThanOrEqual(2);

      await client.disconnect();
    });
  });

  // -------------------------------------------------------------------------
  // Reconnect backoff — permanent-wedge regression
  // -------------------------------------------------------------------------

  describe('reconnect backoff', () => {
    const config: McpServerConfig = {
      name: 'srv',
      transport: 'stdio',
      command: 'node',
      keepaliveSeconds: 0,
      connectTimeoutMs: 500,
    };

    /** Connect once, then drop the connection so attempt 0 is scheduled. */
    async function connectThenDrop(client: McpClient): Promise<void> {
      await client.connect();
      const { Client } = await import('@modelcontextprotocol/sdk/client');
      const instances = vi.mocked(Client).mock.results;
      const sdkInstance = instances[instances.length - 1]?.value;
      sdkInstance?.onclose?.();
    }

    it('keeps the first five delays at 1s/2s/4s/8s/16s', async () => {
      const client = new McpClient(config);
      await connectThenDrop(client);
      mockConnect.mockRejectedValue(new Error('boom'));

      // Initial successful connect is call #1; each retry adds one.
      let expected = 1;
      for (const delay of [1000, 2000, 4000, 8000, 16_000]) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(mockConnect).toHaveBeenCalledTimes(expected);
        await vi.advanceTimersByTimeAsync(1);
        expected += 1;
        expect(mockConnect).toHaveBeenCalledTimes(expected);
      }

      await client.disconnect();
    });

    it('keeps retrying past attempt 5 at the 30s cap', async () => {
      const client = new McpClient(config);
      await connectThenDrop(client);
      mockConnect.mockRejectedValue(new Error('boom'));

      // Five failures: attempts 0..4 at 1s/2s/4s/8s/16s.
      await vi.advanceTimersByTimeAsync(31_000);
      expect(mockConnect).toHaveBeenCalledTimes(6);

      // Attempt 5 onwards holds at the 30s cap and does NOT give up.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockConnect).toHaveBeenCalledTimes(7);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockConnect).toHaveBeenCalledTimes(8);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockConnect).toHaveBeenCalledTimes(9);

      // A late recovery (attempt 8) still revives the client.
      mockConnect.mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(client.isConnected()).toBe(true);

      expect(await client.callTool('t', {})).toEqual({ ok: true, value: 'ok' });

      await client.disconnect();
    });

    it('stops the retry chain once disconnected', async () => {
      const client = new McpClient(config);
      await connectThenDrop(client);
      mockConnect.mockRejectedValue(new Error('boom'));

      await vi.advanceTimersByTimeAsync(31_000);
      expect(mockConnect).toHaveBeenCalledTimes(6);

      await client.disconnect();

      await vi.advanceTimersByTimeAsync(300_000);
      expect(mockConnect).toHaveBeenCalledTimes(6);
    });
  });

  // -------------------------------------------------------------------------
  // 1.3 Shutdown cleanup
  // -------------------------------------------------------------------------

  describe('shutdown cleanup', () => {
    it('disconnect clears keepalive interval', async () => {
      const config: McpServerConfig = {
        name: 'srv',
        transport: 'stdio',
        command: 'node',
        keepaliveSeconds: 5,
      };
      const client = new McpClient(config);
      await client.connect();
      await client.disconnect();

      mockPing.mockClear();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockPing).not.toHaveBeenCalled();
    });

    it('disconnect calls transport.close()', async () => {
      const config: McpServerConfig = {
        name: 'srv',
        transport: 'stdio',
        command: 'node',
        keepaliveSeconds: 0,
      };
      const client = new McpClient(config);
      await client.connect();
      await client.disconnect();

      expect(mockTransportClose).toHaveBeenCalledTimes(1);
    });

    it('disconnect closes transport (child cleanup delegated to SDK)', async () => {
      const config: McpServerConfig = {
        name: 'srv',
        transport: 'stdio',
        command: 'node',
        keepaliveSeconds: 0,
      };
      const client = new McpClient(config);
      await client.connect();
      await client.disconnect();

      expect(mockTransportClose).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
    });

    it('McpManager.shutdown() is an alias for disconnect()', async () => {
      const manager = new McpManager([
        { name: 'a', transport: 'stdio', command: 'node', keepaliveSeconds: 0 },
      ]);
      await manager.connect();
      await manager.shutdown();
      expect(mockClose).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 1.4 Cross-server tool-name collision detection
  // -------------------------------------------------------------------------

  describe('tool-name collision detection', () => {
    it('warns on collision in warn mode (default)', async () => {
      const warnFn = vi.fn();
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: warnFn,
        error: vi.fn(),
        child: vi.fn().mockReturnThis(),
      };

      let callCount = 0;
      mockListTools.mockImplementation(() => {
        callCount++;
        // Both servers expose 'read_file'
        return Promise.resolve({
          tools: [
            {
              name: 'read_file',
              description: `Read file (server ${callCount})`,
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        });
      });

      const manager = new McpManager(
        [
          { name: 'server_a', transport: 'stdio', command: 'node', keepaliveSeconds: 0 },
          { name: 'server_b', transport: 'stdio', command: 'node', keepaliveSeconds: 0 },
        ],
        { logger },
      );
      await manager.connect();

      // Should have logged a collision warning
      const collisionWarns = warnFn.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('collision'),
      );
      expect(collisionWarns.length).toBeGreaterThanOrEqual(1);
      expect(collisionWarns[0][0]).toContain('read_file');
      expect(collisionWarns[0][0]).toContain('server_a');
      expect(collisionWarns[0][0]).toContain('server_b');

      // Tools should still be registered (warn mode doesn't block)
      expect(manager.getTools()).toHaveLength(2);

      await manager.disconnect();
    });

    it('throws on collision in error mode', async () => {
      let callCount = 0;
      mockListTools.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          tools: [
            {
              name: 'read_file',
              description: `Read file (server ${callCount})`,
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        });
      });

      const manager = new McpManager(
        [
          { name: 'server_a', transport: 'stdio', command: 'node', keepaliveSeconds: 0 },
          { name: 'server_b', transport: 'stdio', command: 'node', keepaliveSeconds: 0 },
        ],
        { collisionPolicy: 'error' },
      );

      await expect(manager.connect()).rejects.toThrow(/collision/i);
    });

    it('does not warn when tools have unique names', async () => {
      const warnFn = vi.fn();
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: warnFn,
        error: vi.fn(),
        child: vi.fn().mockReturnThis(),
      };

      let callCount = 0;
      mockListTools.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          tools: [
            {
              name: `unique_tool_${callCount}`,
              description: `Tool ${callCount}`,
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        });
      });

      const manager = new McpManager(
        [
          { name: 'server_a', transport: 'stdio', command: 'node', keepaliveSeconds: 0 },
          { name: 'server_b', transport: 'stdio', command: 'node', keepaliveSeconds: 0 },
        ],
        { logger },
      );
      await manager.connect();

      // No collision warnings
      const collisionWarns = warnFn.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('collision'),
      );
      expect(collisionWarns).toHaveLength(0);

      await manager.disconnect();
    });
  });
});
