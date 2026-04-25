import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Tool, ToolResult } from '@ethosagent/types';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'sse';
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // sse
  url?: string;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// McpClient — wraps one MCP server connection
// ---------------------------------------------------------------------------

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export class McpClient {
  private _sdk: Client;
  private _config: McpServerConfig;
  private _connected = false;
  private _pending = new Map<symbol, (err: Error) => void>();
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _destroyed = false;

  constructor(config: McpServerConfig) {
    this._config = config;
    this._sdk = new Client({ name: 'ethos', version: '1.0.0' }, { capabilities: {} });
  }

  get name(): string {
    return this._config.name;
  }

  async connect(): Promise<void> {
    const transport = await this._createTransport();

    this._sdk.onclose = () => {
      this._connected = false;
      const err = new Error(`MCP server '${this._config.name}' disconnected`);
      for (const reject of this._pending.values()) reject(err);
      this._pending.clear();
      if (!this._destroyed) this._scheduleReconnect(0);
    };

    await this._sdk.connect(transport);
    this._connected = true;
  }

  protected async _createTransport() {
    if (this._config.transport === 'stdio') {
      const { command } = this._config;
      if (!command)
        throw new Error(`MCP server '${this._config.name}': stdio transport requires 'command'`);
      return new StdioClientTransport({
        command,
        args: this._config.args,
        env: this._config.env,
        stderr: 'pipe',
      });
    }

    if (this._config.transport === 'sse') {
      const { url } = this._config;
      if (!url) throw new Error(`MCP server '${this._config.name}': sse transport requires 'url'`);
      // Lazy import to avoid pulling in eventsource when not needed
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
      return new SSEClientTransport(new URL(url), {
        requestInit: this._config.headers ? { headers: this._config.headers } : undefined,
      });
    }

    throw new Error(
      `MCP server '${this._config.name}': unknown transport '${this._config.transport}'`,
    );
  }

  private _scheduleReconnect(attempt: number): void {
    if (this._destroyed || attempt >= 5) return;
    const delay = Math.min(1000 * 2 ** attempt, 30_000);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      // Re-create the SDK client — old one is done
      this._sdk = new Client({ name: 'ethos', version: '1.0.0' }, { capabilities: {} });
      try {
        await this.connect();
      } catch {
        this._scheduleReconnect(attempt + 1);
      }
    }, delay);
  }

  isConnected(): boolean {
    return this._connected;
  }

  async listTools(): Promise<McpToolDef[]> {
    const result = await this._sdk.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  }

  async callTool(name: string, args: unknown): Promise<ToolResult> {
    if (!this._connected) {
      return {
        ok: false,
        error: `MCP server '${this._config.name}' is not connected`,
        code: 'not_available',
      };
    }

    const key = Symbol();
    const guard = new Promise<never>((_, reject) => {
      this._pending.set(key, reject);
    });

    try {
      const raw = await Promise.race([
        this._sdk.callTool({ name, arguments: args as Record<string, unknown> }),
        guard,
      ]);

      const isError = raw.isError === true;
      const content = raw.content as Array<{ type: string; text?: string }>;
      const text = content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n');

      if (isError) {
        return { ok: false, error: text || 'Tool returned an error', code: 'execution_failed' };
      }
      return { ok: true, value: text || '(no output)' };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: 'execution_failed',
      };
    } finally {
      this._pending.delete(key);
    }
  }

  async disconnect(): Promise<void> {
    this._destroyed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._connected = false;
    try {
      await this._sdk.close();
    } catch {
      // Ignore errors on close
    }
  }
}

// ---------------------------------------------------------------------------
// Tool adapter
// ---------------------------------------------------------------------------

function adaptMcpTool(mcpTool: McpToolDef, serverName: string, client: McpClient): Tool {
  return {
    name: `mcp__${serverName}__${mcpTool.name}`,
    description: mcpTool.description ?? mcpTool.name,
    schema: mcpTool.inputSchema,
    toolset: 'mcp',
    maxResultChars: 50_000,
    isAvailable: () => client.isConnected(),
    execute(args) {
      return client.callTool(mcpTool.name, args);
    },
  };
}

// ---------------------------------------------------------------------------
// McpManager — manages multiple clients
// ---------------------------------------------------------------------------

export class McpManager {
  private _clients: McpClient[];
  private _tools: Tool[] = [];

  constructor(configs: McpServerConfig[]) {
    this._clients = configs.map((c) => new McpClient(c));
  }

  async connect(): Promise<void> {
    await Promise.allSettled(
      this._clients.map(async (client) => {
        try {
          await client.connect();
        } catch (err) {
          console.warn(
            `[ethos] MCP server '${client.name}' failed to connect:`,
            err instanceof Error ? err.message : String(err),
          );
          return;
        }

        try {
          const mcpTools = await client.listTools();
          for (const t of mcpTools) {
            this._tools.push(adaptMcpTool(t, client.name, client));
          }
        } catch (err) {
          console.warn(
            `[ethos] MCP server '${client.name}' listTools failed:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }),
    );
  }

  getTools(): Tool[] {
    return this._tools;
  }

  async disconnect(): Promise<void> {
    await Promise.allSettled(this._clients.map((c) => c.disconnect()));
  }
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

export async function loadMcpConfig(): Promise<McpServerConfig[]> {
  try {
    const path = join(homedir(), '.ethos', 'mcp.json');
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as McpServerConfig[];
  } catch {
    return [];
  }
}
