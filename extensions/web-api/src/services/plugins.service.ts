import type { McpServerInfo, PluginInfo } from '@ethosagent/web-contracts';
import type { McpRepository } from '../repositories/mcp.repository';
import type { PluginsRepository } from '../repositories/plugins.repository';

// Plugins service — composes the two read-only repositories that
// surface what's installed locally:
//
//   • PluginsRepository — ~/.ethos/plugins/<id>/package.json scan
//   • McpRepository     — ~/.ethos/mcp.json
//
// Both lists land in the single `plugins.list` RPC because the UI
// renders them in one tab.

export interface PluginsServiceOptions {
  plugins: PluginsRepository;
  mcp: McpRepository;
}

export class PluginsService {
  constructor(private readonly opts: PluginsServiceOptions) {}

  async list(): Promise<{ plugins: PluginInfo[]; mcpServers: McpServerInfo[] }> {
    const [plugins, mcpServers] = await Promise.all([
      this.opts.plugins.listPlugins(),
      this.opts.mcp.listServers(),
    ]);
    return { plugins, mcpServers };
  }
}
