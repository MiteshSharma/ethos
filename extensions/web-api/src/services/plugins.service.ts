import { type InstalledPluginManifest, scanInstalledPlugins } from '@ethosagent/plugin-loader';
import { type McpServerConfig, loadMcpConfig } from '@ethosagent/tools-mcp';
import type { Storage } from '@ethosagent/types';
import type { McpServerInfo, PluginInfo } from '@ethosagent/web-contracts';

// Plugins service — composes the plugin manifest scan
// (~/.ethos/plugins/<id>/) and the MCP config (~/.ethos/mcp.json).
// Calls into @ethosagent/plugin-loader's `scanInstalledPlugins` and
// @ethosagent/tools-mcp's `loadMcpConfig`; sanitisation + sort happen
// here so the extensions stay free of web-contract types.

export interface PluginsServiceOptions {
  storage: Storage;
  /** Root data dir — `~/.ethos/`. */
  dataDir: string;
  /** Working dir for the optional project-level scan. */
  workingDir?: string;
}

export class PluginsService {
  constructor(private readonly opts: PluginsServiceOptions) {}

  async list(): Promise<{ plugins: PluginInfo[]; mcpServers: McpServerInfo[] }> {
    const [manifests, mcpRaw] = await Promise.all([
      scanInstalledPlugins({
        userDir: this.opts.dataDir,
        storage: this.opts.storage,
        ...(this.opts.workingDir ? { workingDir: this.opts.workingDir } : {}),
      }),
      loadMcpConfig(this.opts.storage),
    ]);
    const mcpServers = mcpRaw
      .filter(isValidMcpServer)
      .map(toWireMcpServer)
      .sort((a, b) => a.name.localeCompare(b.name));
    return { plugins: manifests.map(toWirePlugin), mcpServers };
  }
}

function toWirePlugin(m: InstalledPluginManifest): PluginInfo {
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description,
    source: m.source,
    path: m.path,
    pluginContractMajor: m.pluginContractMajor,
  };
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
