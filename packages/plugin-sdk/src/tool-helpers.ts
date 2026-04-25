import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Result shorthands
// ---------------------------------------------------------------------------

/** Shorthand for a successful tool result. */
export function ok(value: string): ToolResult {
  return { ok: true, value };
}

type ToolErrorCode = 'input_invalid' | 'not_available' | 'execution_failed';

/** Shorthand for a failed tool result. */
export function err(error: string, code: ToolErrorCode = 'execution_failed'): ToolResult {
  return { ok: false, error, code };
}

// ---------------------------------------------------------------------------
// Tool definition builder
// ---------------------------------------------------------------------------

export interface ToolDefinition<TArgs = unknown> {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  toolset?: string;
  maxResultChars?: number;
  isAvailable?: () => boolean;
  execute: (args: TArgs, ctx: ToolContext) => Promise<ToolResult>;
}

/**
 * Type-safe tool factory. Identical to writing a `Tool` object directly,
 * but provides better inference when `TArgs` is specified.
 *
 * @example
 * const myTool = defineTool<{ query: string }>({
 *   name: 'my_search',
 *   description: 'Search for something',
 *   schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
 *   async execute({ query }, ctx) {
 *     return ok(`Results for: ${query}`);
 *   },
 * });
 */
export function defineTool<TArgs = unknown>(def: ToolDefinition<TArgs>): Tool<TArgs> {
  return def as Tool<TArgs>;
}
