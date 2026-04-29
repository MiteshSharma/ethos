export type ToolResult =
  | { ok: true; value: string }
  | { ok: false; error: string; code: 'input_invalid' | 'not_available' | 'execution_failed' };

export interface ToolProgressEvent {
  type: 'progress';
  toolName: string;
  message: string;
  percent?: number;
  /**
   * Phase 30.2 — audience boundary.
   *
   * `'internal'` (default when absent): consumed by the framework only —
   * logs, telemetry, dev-mode TUI. Channel adapters (telegram, discord,
   * slack, whatsapp, email) and `apps/ethos/src/commands/chat.ts` MUST NOT
   * surface it to the user.
   *
   * `'user'`: explicit opt-in by the tool author — surfaced in the user-
   * visible stream. Use sparingly: long-running operations where silent
   * latency would be confusing (`read_file` reading >1MB, multi-step
   * `bash` commands). Per-event opt-in; the framework never opts in for
   * the tool.
   */
  audience?: 'internal' | 'user';
}

export interface ToolContext {
  sessionId: string;
  sessionKey: string;
  platform: string;
  workingDir: string;
  agentId?: string;
  /** Active personality for this turn. Tools that touch memory must thread this through. */
  personalityId?: string;
  /** Resolved memory scope for the active personality (filled by AgentLoop). */
  memoryScope?: 'global' | 'per-personality';
  currentTurn: number;
  messageCount: number;
  abortSignal: AbortSignal;
  emit: (event: ToolProgressEvent) => void;
  resultBudgetChars: number;
  /**
   * Per-turn Storage decorated by ScopedStorage with the active personality's
   * fs_reach allowlist. Tools that touch the filesystem (read_file,
   * write_file, patch_file, search_files) must route reads/writes through
   * this rather than `node:fs/promises` directly so the personality boundary
   * is enforced. Optional because not every consumer wires it (CLI/tests
   * may pass a tool execution context without storage); tools fall back to
   * unrestricted fs in that case.
   */
  storage?: import('./storage').Storage;
}

export interface Tool<TArgs = unknown> {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  toolset?: string;
  maxResultChars?: number;
  execute: (args: TArgs, ctx: ToolContext) => Promise<ToolResult>;
  isAvailable?: () => boolean;
}

export interface ToolRegistry {
  register(tool: Tool): void;
  registerAll(tools: Tool[]): void;
  unregister(name: string): void;
  get(name: string): Tool | undefined;
  getAvailable(): Tool[];
  getForToolset(toolset: string): Tool[];
  executeParallel(
    calls: Array<{ toolCallId: string; name: string; args: unknown }>,
    ctx: ToolContext,
    allowedTools?: string[],
  ): Promise<Array<{ toolCallId: string; name: string; result: ToolResult }>>;
  toDefinitions(allowedTools?: string[]): import('./llm').ToolDefinitionLite[];
}
