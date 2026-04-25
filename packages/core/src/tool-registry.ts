import type { Tool, ToolContext, ToolRegistry, ToolResult } from '@ethosagent/types';

export class DefaultToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
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
    return this.tools.get(name);
  }

  getAvailable(): Tool[] {
    return [...this.tools.values()].filter((t) => !t.isAvailable || t.isAvailable());
  }

  getForToolset(toolset: string): Tool[] {
    return this.getAvailable().filter((t) => t.toolset === toolset);
  }

  toDefinitions(allowedTools?: string[]) {
    const available = this.getAvailable();
    const filtered =
      allowedTools && allowedTools.length > 0
        ? available.filter((t) => allowedTools.includes(t.name))
        : available;
    return filtered.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.schema,
    }));
  }

  // Runs all tool calls in parallel. Results are returned in input order.
  // Budget is split evenly across parallel calls; each result is post-trimmed to budget.
  // allowedTools enforces toolset at execution time (belt-and-suspenders after toDefinitions filtering).
  async executeParallel(
    calls: Array<{ toolCallId: string; name: string; args: unknown }>,
    ctx: ToolContext,
    allowedTools?: string[],
  ): Promise<Array<{ toolCallId: string; name: string; result: ToolResult }>> {
    const perCallBudget = Math.floor(ctx.resultBudgetChars / Math.max(calls.length, 1));

    const results = await Promise.allSettled(
      calls.map(async (call) => {
        if (allowedTools && allowedTools.length > 0 && !allowedTools.includes(call.name)) {
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

        const tool = this.tools.get(call.name);
        if (!tool) {
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

        if (tool.isAvailable && !tool.isAvailable()) {
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

        const budget = Math.min(perCallBudget, tool.maxResultChars ?? perCallBudget);
        const toolCtx: ToolContext = { ...ctx, resultBudgetChars: budget };

        try {
          const result = await tool.execute(call.args, toolCtx);
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
