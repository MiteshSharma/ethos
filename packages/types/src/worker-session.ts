// ---------------------------------------------------------------------------
// WorkerSession — the contract between a runner adapter and a worker harness.
//
// Everything above a runner talks to THIS; transports live below it. Pi's
// newline-delimited JSON-RPC over stdio and an HTTP+SSE harness are both
// implementations of the same seven methods. A transport detail must never
// reach the router, the executor, or the UI.
//
// Contract only — nothing implements it yet. The first implementation ships
// with the first out-of-process harness adapter.
// ---------------------------------------------------------------------------

export interface SessionSpec {
  /** Absolute path the worker may work in (its own worktree, never the parent's). */
  workspace: string;
  /** Inherited from the caller, guard-enforced — a worker never picks its own. */
  personalityId?: string;
  /** USD spend cap for the session; absent means the harness's own default. */
  maxCostUsd?: number;
}

export interface SessionHandle {
  /** The harness's own session id, opaque to Ethos. */
  sessionId: string;
}

/**
 * A question the worker cannot answer itself. `kind` is an OPEN string: a
 * harness that invents a kind we have never seen is the normal case, not an
 * error case, and an unknown kind degrades to a default rendering.
 */
export interface InteractionRequest {
  requestId: string;
  kind: string;
  prompt: string;
  options?: { value: string; label: string }[];
  /** JSON Schema for structured answers, when the harness supplies one. */
  schema?: Record<string, unknown>;
  /** Secret material — never rendered, never persisted. */
  sensitive?: boolean;
  defaultValue?: string;
  /** Set when the ask is scoped to one tool (tool-scoped permission prompts). */
  toolName?: string;
  meta?: Record<string, unknown>;
}

export interface InteractionAnswer {
  requestId: string;
  value: unknown;
  /**
   * How long this answer stands. A harness that only understands one-shot
   * answers declares `['once']` in its `RunnerCapabilities.answerScopes` and
   * surfaces stop offering the other buttons.
   */
  scope: 'once' | 'run' | 'always';
  source: 'auto' | 'human' | 'timeout-default' | 'cancel';
}

/** Normalized worker output. Cancel and steer travel OUTSIDE this stream so
 *  "stop" is instant mid-stream rather than queued behind pending events. */
export type WorkerEvent =
  | { type: 'status'; message: string }
  | { type: 'text'; text: string }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_end'; toolCallId: string; toolName: string; ok: boolean; durationMs: number }
  | { type: 'interaction'; request: InteractionRequest }
  | { type: 'artifact'; change: import('./background-job').ArtifactChange }
  | { type: 'done'; text: string }
  | { type: 'error'; error: string };

export interface WorkerSession {
  open(spec: SessionSpec): Promise<SessionHandle>;
  /** Async — never blocks on the turn completing. */
  submit(prompt: string): Promise<void>;
  events(): AsyncIterable<WorkerEvent>;
  answer(a: InteractionAnswer): Promise<void>;
  /** Only meaningful when the runner declares `capabilities.steer`. */
  steer(text: string): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}
