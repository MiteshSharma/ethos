import { type McpServerConfig, loadMcpConfig } from '@ethosagent/tools-mcp';
import type { Storage } from '@ethosagent/types';
import type { McpServerInfo, PluginInfo } from '@ethosagent/web-contracts';
import type { PluginsRepository } from '../repositories/plugins.repository';

// Plugins service — composes the plugin scan (~/.ethos/plugins/<id>/) and
// the MCP config (~/.ethos/mcp.json). Calls into @ethosagent/tools-mcp's
// `loadMcpConfig` directly; sanitisation + sort happen here so the
// extension stays free of web-contract types.

export interface PluginsServiceOptions {
  plugins: PluginsRepository;
  storage: Storage;
}

export class PluginsService {
  constructor(private readonly opts: PluginsServiceOptions) {}

  async list(): Promise<{ plugins: PluginInfo[]; mcpServers: McpServerInfo[] }> {
    const [plugins, mcpRaw] = await Promise.all([
      this.opts.plugins.listPlugins(),
      loadMcpConfig(this.opts.storage),
    ]);
    const mcpServers = mcpRaw
      .filter(isValidMcpServer)
      .map(toWireMcpServer)
      .sort((a, b) => a.name.localeCompare(b.name));
    return { plugins, mcpServers };
  }
}

function isValidMcpServer(entry: McpServerConfig): boolean {
  if (typeof entry.name !== 'string') return false;
  return entry.transport === 'stdio' || entry.transport === 'sse';
}

function toWireMcpServer(entry: McpServerConfig): McpServerInfo {
  return {
    name: entry.name,
    transport: entry.transport,
    command: typeof entry.command === 'string' ? entry.command : null,
    url: typeof entry.url === 'string' ? entry.url : null,
  };
}
