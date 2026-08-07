import type {
  PersonalityConfig,
  Tool,
  ToolCapabilities,
  ToolContext,
  ToolExecuteRequest,
  ToolFilterOpts,
  ToolReducerContext,
  ToolRegistry,
  ToolResult,
  ToolResultReducer,
  ToolResultReducerRegistry,
  ToolTransport,
} from '@ethosagent/types';
import type { CapabilityBackends } from './capability-resolver';
import type { CapabilityValidationError } from './capability-validator';
import { validateRegistration } from './capability-validator';
import type { LocalToolTransportLiveCtx } from './local-tool-transport';
import { LocalToolTransport } from './local-tool-transport';

function needsBackends(caps: ToolCapabilities | undefined): boolean {
  if (!caps) return false;
  return !!(
    caps.network ||
    caps.secrets ||
    caps.storage ||
    caps.fs_reach ||
    caps.process ||
    caps.attachments
  );
}

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

  const { allowedMcpServers, allowedPlugins, allowedMcpTools } = filterOpts;
  const toolName = entry.tool.name;

  // MCP server gate: MCP tools only appear when their server is in the allowlist.
  if (allowedMcpServers !== undefined) {
    const server = mcpServerName(toolName);
    if (server !== undefined && !allowedMcpServers.includes(server)) return false;
  }

  // Per-tool MCP gate: after the server-level gate passes, check tool-level allowlist.
  if (allowedMcpTools !== undefined) {
    const server = mcpServerName(toolName);
    if (server !== undefined) {
      const allowed = allowedMcpTools[server];
      if (allowed !== undefined) {
        // Extract bare tool name: mcp__linear__list_issues -> list_issues
        const bareName = toolName.split('__').slice(2).join('__');
        if (!allowed.includes(bareName)) return false;
      }
    }
  }

  // Plugin gate: plugin tools only appear when their plugin is in the allowlist.
  if (allowedPlugins !== undefined && entry.pluginId !== undefined) {
    if (!allowedPlugins.includes(entry.pluginId)) return false;
  }

  return true;
}

function safeReduce(r: ToolResultReducer, result: ToolResult, ctx: ToolReducerContext): ToolResult {
  try {
    return r.reduce(result, ctx);
  } catch {
    return result;
  }
}

const DEFAULT_CACHE_TTL_MS = 300_000;
const MAX_CACHE_ENTRIES = 1000;

interface CacheEntry {
  result: ToolResult;
  expiresAt: number | null;
}

export class DefaultToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, ToolEntry>();
  private readonly resultCache = new Map<string, CacheEntry>();
  private readonly backends?: CapabilityBackends;
  private readonly reducers?: ToolResultReducerRegistry;
  private readonly transport: ToolTransport;

  // Per-turn live context — updated by executeParallel before dispatching.
  private turnLiveCtx: LocalToolTransportLiveCtx = { emit: () => {} };

  constructor(
    backends?: CapabilityBackends,
    reducers?: ToolResultReducerRegistry,
    transport?: ToolTransport,
  ) {
    this.backends = backends;
    this.reducers = reducers;
    this.transport =
      transport ??
      new LocalToolTransport(
        (name) => this.tools.get(name)?.tool,
        backends,
        () => this.turnLiveCtx,
      );
  }

  private cacheGet(tool: Tool, args: unknown, ctx: ToolContext): ToolResult | null {
    if (!tool.cache) return null;
    const opts = tool.cache === true ? {} : tool.cache;
    const keyPart = opts.keyFn ? opts.keyFn(args) : JSON.stringify(args);
    const key = `${tool.name}:${ctx.sessionId}:${ctx.personalityId ?? ''}:${keyPart}`;
    const entry = this.resultCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.resultCache.delete(key);
      return null;
    }
    return entry.result;
  }

  private cacheSet(tool: Tool, args: unknown, result: ToolResult, ctx: ToolContext): void {
    if (!tool.cache) return;
    const opts = tool.cache === true ? {} : tool.cache;
    const keyPart = opts.keyFn ? opts.keyFn(args) : JSON.stringify(args);
    const key = `${tool.name}:${ctx.sessionId}:${ctx.personalityId ?? ''}:${keyPart}`;
    const ttl = opts.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    const expiresAt = Date.now() + ttl;
    this.resultCache.set(key, { result, expiresAt });
    if (this.resultCache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.resultCache.keys().next().value;
      if (oldest !== undefined) {
        this.resultCache.delete(oldest);
      }
    }
  }

  register(tool: Tool, opts?: { pluginId?: string }): void {
    this.tools.set(tool.name, { tool, pluginId: opts?.pluginId });
  }

  /**
   * Validate every tool reachable for this personality (per
   * `toolNamesForPersonality`) against the personality's policy. Only
   * the tools the personality could actually call are checked — a
   * personality that doesn't list `web_search` in its toolset does not
   * fail because `web_search` declared `api.exa.ai` that's missing from
   * `network.allow`.
   */
  validateToolsForPersonality(personality: PersonalityConfig): CapabilityValidationError[] {
    const reach = this.toolNamesForPersonality(personality);
    const errors: CapabilityValidationError[] = [];
    for (const entry of this.tools.values()) {
      if (!reach.has(entry.tool.name)) continue;
      errors.push(...validateRegistration(entry.tool, personality));
    }
    return errors;
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

  /** v2.2 — Return the plugin id that registered a tool, if any. */
  getPluginId(name: string): string | undefined {
    return this.tools.get(name)?.pluginId;
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
        !e.tool.alwaysInclude &&
        allowedTools &&
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

  /**
   * Computes the effective tool reach for a personality:
   *   personality.toolset (built-in tools)
   *   ∪ tools from MCP servers in personality.mcp_servers
   *   ∪ tools from plugins in personality.plugins
   *
   * Used by IngestFilter to check skill.required_tools ⊆ effective_reach.
   */
  toolNamesForPersonality(personality: PersonalityConfig): Set<string> {
    const reach = new Set<string>();

    for (const [name, entry] of this.tools) {
      const isMcp = name.startsWith('mcp__');
      const isPlugin = entry.pluginId !== undefined;

      if (!isMcp && !isPlugin) {
        // Built-in tool — include if in personality.toolset (or if toolset is unrestricted)
        const toolset = personality.toolset;
        if (!toolset || toolset.includes(name)) {
          reach.add(name);
        }
      } else if (isMcp) {
        const server = mcpServerName(name);
        const allowed = personality.mcp_servers;
        if (server && allowed?.includes(server)) {
          reach.add(name);
        }
      } else if (isPlugin) {
        const allowed = personality.plugins;
        if (entry.pluginId && allowed?.includes(entry.pluginId)) {
          reach.add(name);
        }
      }
    }

    return reach;
  }

  // Runs all tool calls in parallel. Results are returned in input order.
  // Budget is split evenly across parallel calls; each result is post-trimmed to budget.
  // allowedTools + filterOpts enforce tool access at execution time (belt-and-suspenders).
  private async applyFilters(
    filters: import('@ethosagent/types').ToolInvocationFilter[],
    tool: Tool,
    args: unknown,
    ctx: ToolContext,
    meta: { toolName: string; toolCallId: string },
    execute: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    const matching = filters.filter(
      (f) =>
        (!f.toolName ||
          (Array.isArray(f.toolName)
            ? f.toolName.includes(meta.toolName)
            : f.toolName === meta.toolName)) &&
        (!f.toolset || tool.toolset === f.toolset),
    );

    let shortCircuit: ToolResult | null = null;
    for (const f of matching) {
      if (f.before) {
        const r = await f.before(args, ctx, meta);
        if (r !== null) {
          shortCircuit = r;
          break;
        }
      }
    }

    let result = shortCircuit ?? (await execute());

    for (const f of matching) {
      if (f.after) result = await f.after(result, ctx, meta);
    }

    return result;
  }

  async executeParallel(
    calls: Array<{ toolCallId: string; name: string; args: unknown }>,
    ctx: ToolContext,
    allowedTools?: string[],
    filterOpts?: ToolFilterOpts,
    turnAttachments?: import('@ethosagent/types').Attachment[],
    filters?: import('@ethosagent/types').ToolInvocationFilter[],
  ): Promise<Array<{ toolCallId: string; name: string; result: ToolResult }>> {
    const perCallBudget = Math.floor(ctx.resultBudgetChars / Math.max(calls.length, 1));

    // Update live turn context for the default LocalToolTransport
    this.turnLiveCtx = {
      emit: ctx.emit,
      readMtimes: ctx.readMtimes,
      storage: ctx.storage,
      inboundAttachments: turnAttachments,
      a2aDelegation: ctx.a2aDelegation,
      scriptTools: ctx.scriptTools,
    };

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
          !entry.tool.alwaysInclude &&
          allowedTools &&
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

        // v2: result cache — check before executing
        const cached = this.cacheGet(entry.tool, call.args, ctx);
        if (cached) {
          return { toolCallId: call.toolCallId, name: call.name, result: cached };
        }

        // Fail closed: tools that declare real capabilities require wired backends.
        // capabilities: {} (empty) is opt-in to the framework path without needing backends.
        if (needsBackends(entry.tool.capabilities) && !this.backends) {
          return {
            toolCallId: call.toolCallId,
            name: call.name,
            result: {
              ok: false,
              error: `Tool ${call.name} declares capabilities but no capability backends are configured`,
              code: 'not_available',
            } as ToolResult,
          };
        }

        // Dry-run mode: return a synthetic result without executing the tool.
        // Dynamic import keeps the non-dry-run path lean.
        if (ctx.dryRun) {
          const { synthesizeDryRunResult } = await import('./dry-run');
          return {
            toolCallId: call.toolCallId,
            name: call.name,
            result: synthesizeDryRunResult(call.name, call.args),
          };
        }

        const cappedBudget = Math.min(perCallBudget, entry.tool.maxResultChars ?? perCallBudget);

        try {
          const request: ToolExecuteRequest = {
            toolCallId: call.toolCallId,
            name: call.name,
            args: call.args,
            sessionId: ctx.sessionId,
            sessionKey: ctx.sessionKey,
            platform: ctx.platform,
            workingDir: ctx.workingDir,
            personalityId: ctx.personalityId,
            teamId: ctx.teamId,
            agentId: ctx.agentId,
            origin: ctx.origin,
            memoryScopeId: ctx.memoryScopeId,
            userScopeId: ctx.userScopeId,
            currentTurn: ctx.currentTurn,
            messageCount: ctx.messageCount,
            resultBudgetChars: cappedBudget,
            networkPolicy: ctx.networkPolicy,
            dryRun: ctx.dryRun,
          };

          const rawResult =
            filters && filters.length > 0
              ? await this.applyFilters(
                  filters,
                  entry.tool,
                  call.args,
                  ctx,
                  { toolName: call.name, toolCallId: call.toolCallId },
                  () => this.transport.execute(request, ctx.abortSignal),
                )
              : await this.transport.execute(request, ctx.abortSignal);
          // Apply reducer before budget trim so budget sees post-reduced text
          const reducer = this.reducers?.get(call.name);
          const result = reducer
            ? safeReduce(reducer, rawResult, { args: call.args, turnCount: ctx.currentTurn ?? 0 })
            : rawResult;
          // Post-trim result to budget
          if (result.ok && result.value.length > cappedBudget) {
            return {
              toolCallId: call.toolCallId,
              name: call.name,
              result: {
                ok: true,
                value: `${result.value.slice(0, cappedBudget)}\n[truncated — ${result.value.length} chars total]`,
              } as ToolResult,
            };
          }
          // v2: cache the result if applicable
          this.cacheSet(entry.tool, call.args, result, ctx);
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
