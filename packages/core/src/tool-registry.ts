import type {
  Tool,
  ToolContext,
  ToolFilterOpts,
  ToolRegistry,
  ToolResult,
} from '@ethosagent/types';

interface ToolEntry {
  tool: Tool;
  pluginId?: string;
}

/** Extract MCP server name from `mcp__<server>__<tool>` naming convention. */
function mcpServerName(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined;
  return toolName.split('__')[1];
}

/** Returns true when a tool passes the MCP server + plugin filters. */
function passesFilter(entry: ToolEntry, filterOpts: ToolFilterOpts | undefined): boolean {
  if (!filterOpts) return true;

  const { allowedMcpServers, allowedPlugins } = filterOpts;

  // MCP server gate: MCP tools only appear when their server is in the allowlist.
  if (allowedMcpServers !== undefined) {
    const server = mcpServerName(entry.tool.name);
    if (server !== undefined && !allowedMcpServers.includes(server)) return false;
  }

  // Plugin gate: plugin tools only appear when their plugin is in the allowlist.
  if (allowedPlugins !== undefined && entry.pluginId !== undefined) {
    if (!allowedPlugins.includes(entry.pluginId)) return false;
  }

  return true;
}

export class DefaultToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, ToolEntry>();

  register(tool: Tool, opts?: { pluginId?: string }): void {
    this.tools.set(tool.name, { tool, pluginId: opts?.pluginId });
  }

  registerAll(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)?.tool;
  }

  getAvailable(): Tool[] {
    return [...this.tools.values()]
      .filter((e) => !e.tool.isAvailable || e.tool.isAvailable())
      .map((e) => e.tool);
  }

  getForToolset(toolset: string): Tool[] {
    return this.getAvailable().filter((t) => t.toolset === toolset);
  }

  toDefinitions(allowedTools?: string[], filterOpts?: ToolFilterOpts) {
    const entries = [...this.tools.values()].filter(
      (e) => !e.tool.isAvailable || e.tool.isAvailable(),
    );

    const filtered = entries.filter((e) => {
      // Toolset (allowedTools) gates BUILT-IN tools by exact name match. MCP and
      // plugin tools are gated separately via passesFilter() — their names are
      // dynamic, so requiring users to enumerate them in toolset.yaml is
      // unworkable. (mcp_servers / plugins allowlists are the gates for those.)
      const isMcpOrPluginTool = e.tool.name.startsWith('mcp__') || e.pluginId !== undefined;
      if (
        !isMcpOrPluginTool &&
        allowedTools &&
        allowedTools.length > 0 &&
        !allowedTools.includes(e.tool.name)
      )
        return false;
      return passesFilter(e, filterOpts);
    });

    return filtered.map((e) => ({
      name: e.tool.name,
      description: e.tool.description,
      parameters: e.tool.schema,
    }));
  }

  // Runs all tool calls in parallel. Results are returned in input order.
  // Budget is split evenly across parallel calls; each result is post-trimmed to budget.
  // allowedTools + filterOpts enforce tool access at execution time (belt-and-suspenders).
  async executeParallel(
    calls: Array<{ toolCallId: string; name: string; args: unknown }>,
    ctx: ToolContext,
    allowedTools?: string[],
    filterOpts?: ToolFilterOpts,
  ): Promise<Array<{ toolCallId: string; name: string; result: ToolResult }>> {
    const perCallBudget = Math.floor(ctx.resultBudgetChars / Math.max(calls.length, 1));

    const results = await Promise.allSettled(
      calls.map(async (call) => {
        const entry = this.tools.get(call.name);
        if (!entry) {
          return {
            toolCallId: call.toolCallId,
            name: call.name,
            result: {
              ok: false,
              error: `Unknown tool: ${call.name}`,
              code: 'not_available',
            } as ToolResult,
          };
        }

        // Toolset (allowedTools) only gates built-in tools — see toDefinitions
        // for the rationale. MCP and plugin tools are gated by passesFilter().
        const isMcpOrPluginTool = call.name.startsWith('mcp__') || entry.pluginId !== undefined;
        if (
          !isMcpOrPluginTool &&
          allowedTools &&
          allowedTools.length > 0 &&
          !allowedTools.includes(call.name)
        ) {
          return {
            toolCallId: call.toolCallId,
            name: call.name,
            result: {
              ok: false,
              error: `Tool ${call.name} is not permitted for this personality`,
              code: 'not_available',
            } as ToolResult,
          };
        }

        // MCP server + plugin filter check
        if (!passesFilter(entry, filterOpts)) {
          return {
            toolCallId: call.toolCallId,
            name: call.name,
            result: {
              ok: false,
              error: `Tool ${call.name} is not permitted for this personality`,
              code: 'not_available',
            } as ToolResult,
          };
        }

        if (entry.tool.isAvailable && !entry.tool.isAvailable()) {
          return {
            toolCallId: call.toolCallId,
            name: call.name,
            result: {
              ok: false,
              error: `Tool ${call.name} is not currently available`,
              code: 'not_available',
            } as ToolResult,
          };
        }

        const budget = Math.min(perCallBudget, entry.tool.maxResultChars ?? perCallBudget);
        const toolCtx: ToolContext = { ...ctx, resultBudgetChars: budget };

        try {
          const result = await entry.tool.execute(call.args, toolCtx);
          // Post-trim result to budget
          if (result.ok && result.value.length > budget) {
            return {
              toolCallId: call.toolCallId,
              name: call.name,
              result: {
                ok: true,
                value: `${result.value.slice(0, budget)}\n[truncated — ${result.value.length} chars total]`,
              } as ToolResult,
            };
          }
          return { toolCallId: call.toolCallId, name: call.name, result };
        } catch (err) {
          return {
            toolCallId: call.toolCallId,
            name: call.name,
            result: {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
              code: 'execution_failed',
            } as ToolResult,
          };
        }
      }),
    );

    // Unwrap settled results — always return, never throw
    return results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const call = calls[i] ?? { toolCallId: 'unknown', name: 'unknown', args: {} };
      return {
        toolCallId: call.toolCallId,
        name: call.name,
        result: {
          ok: false,
          error: String(r.reason),
          code: 'execution_failed',
        } as ToolResult,
      };
    });
  }
}
