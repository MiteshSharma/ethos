// ---------------------------------------------------------------------------
// Agent events emitted by run()
//
// AgentEvent is a forward-compatible discriminated union. New event `type`
// values may be added in any release. **Consumers MUST treat unknown event
// types as a no-op, not throw.** A `switch (event.type)` with no `default`
// case is a forward-compat bug — it will silently break the moment a new
// variant ships. Use `isKnownAgentEvent(event)` if you want an opt-in
// warning during development that a new event type appeared.
//
// Known event types live in `KNOWN_AGENT_EVENT_TYPES` below. Keep it in
// sync when adding a new variant — the `isKnownAgentEvent` helper reads
// from it, and downstream tools (the CLI verbose mode, telemetry filters)
// can iterate it.
// ---------------------------------------------------------------------------

export const KNOWN_AGENT_EVENT_TYPES = [
  'text_delta',
  'thinking_delta',
  'tool_start',
  'tool_progress',
  'tool_end',
  'usage',
  'error',
  'done',
  'halt',
  'context_meta',
  'run_start',
  'dry_run_summary',
  'tool_approval_required',
  'tool_approval_response',
  'evaluators_complete',
  'credential_required',
  'notification_received',
] as const;

export type KnownAgentEventType = (typeof KNOWN_AGENT_EVENT_TYPES)[number];

/**
 * Returns true when the event's `type` is one a current consumer knows
 * about. Useful for development-mode warnings:
 *
 *     for await (const event of loop.run(...)) {
 *       if (!isKnownAgentEvent(event)) {
 *         console.warn('Unknown AgentEvent type:', event.type);
 *         continue;
 *       }
 *       switch (event.type) { ... }
 *     }
 *
 * Production code should silently skip unknown events; this helper is for
 * test runs and dev surfaces that want to alert on newly-added variants.
 */
export function isKnownAgentEvent(event: { type: string }): event is AgentEvent {
  return (KNOWN_AGENT_EVENT_TYPES as readonly string[]).includes(event.type);
}

export interface DryRunToolPlan {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export type ToolProgressAudience = 'internal' | 'user' | 'dashboard';

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  // tools-as-code-api Lane E — `audience` mirrors the Phase 30.2 field on
  // `tool_end`. In-script inner calls emit real tool_start events tagged
  // `'internal'` (toolCallId namespaced `<parentToolCallId>#<n>`); surfaces
  // MUST NOT render those to the user. Absent = LLM-issued call, renders as
  // before. Additive optional field — NOT a new event variant.
  | {
      type: 'tool_start';
      toolCallId: string;
      toolName: string;
      args: unknown;
      audience?: ToolProgressAudience;
    }
  // Phase 30.2 — `audience` gates whether channel adapters / chat.ts surface
  // this event to the user. Default is `'internal'`; tools opt in to `'user'`
  // per event. Framework-emitted budget warnings are `'user'` (see step 7).
  | {
      type: 'tool_progress';
      toolName: string;
      message: string;
      percent?: number;
      audience: ToolProgressAudience;
    }
  | {
      type: 'tool_end';
      toolCallId: string;
      toolName: string;
      ok: boolean;
      durationMs: number;
      // Phase 30.2 — same boundary applies to tool_end success rendering.
      // Failures (`ok: false`) ignore the field and always render.
      audience?: ToolProgressAudience;
      /**
       * Tool output body — the success value when `ok`, or the error
       * message when `ok: false`. Optional so consumers that only care
       * about the status (CLI ASCII chips, telemetry) can ignore it.
       * The web chip surfaces this on expand-on-click without a
       * follow-up history fetch.
       */
      result?: string;
      /** Structured payload from the tool's ToolResult, passed through for
       *  rich-content rendering (e.g. _uiType: 'image' | 'html'). */
      structured?: Record<string, unknown>;
      /** Error message from the tool's ToolResult. Only set when `ok: false`. */
      error?: string;
    }
  // A6 — `cacheReadTokens` / `cacheCreationTokens` are ADDITIVE-OPTIONAL (see
  // ARCHITECTURE.md §VII, Agent event union). They mirror the provider's
  // `TokenUsage` fields and are present only when the provider actually
  // reported cache activity; a cacheless call omits them rather than
  // reporting a misleading 0, so consumers can tell "no caching" apart from
  // "cached nothing this call".
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      estimatedCostUsd: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    }
  | { type: 'error'; error: string; code: string }
  // B3 — `traceId` is ADDITIVE-OPTIONAL (see ARCHITECTURE.md §VII, Agent event
  // union: the bump trigger is adding/removing/renaming a VARIANT, which this
  // is not). It is the turn's observability trace id — the same id the turn's
  // spans hang off and `messages.trace_id` carries — so a surface that only
  // sees the event stream can still name the turn. Absent when no
  // observability adapter is wired.
  | { type: 'done'; text: string; turnCount: number; traceId?: string }
  /**
   * Emitted when the loop stops a turn early for safety: a per-turn tool
   * budget tripped (`kind: 'budget'`, rule is one of 'tool-budget' |
   * 'identical-name' | 'identical-streak') or the safety watcher paused the
   * turn (`kind: 'watcher'`, rule is the watcher rule id). A normal `done`
   * still follows — consumers that judge or persist turn output (e.g. the
   * goal runner) use this event to know the output is truncated, not clean.
   * Watcher *terminations* remain `error` events, not `halt`.
   */
  | {
      type: 'halt';
      kind: 'budget' | 'watcher';
      rule: string;
      toolName?: string;
      count?: number;
      message: string;
    }
  // Emitted once after context injectors run; carries any metadata they wrote to PromptContext.meta.
  | { type: 'context_meta'; data: Record<string, unknown> }
  /**
   * Emitted once at the very start of each turn, before any LLM call.
   * Carries the resolved provider/model and the routing source so consumers
   * (TUI status bar, CLI verbose mode, telemetry) can show the effective model.
   * `source` reflects which routing rule selected the model (see model_update.md).
   *
   * B3 — `traceId` is ADDITIVE-OPTIONAL, same rationale as on `done`. This is
   * the first event of a turn, so it is where a surface learns the turn's
   * identity before any output arrives.
   */
  | {
      type: 'run_start';
      provider: string;
      model: string;
      source: 'team-coordinator' | 'team-personality' | 'personality' | 'global';
      traceId?: string;
    }
  | {
      type: 'dry_run_summary';
      plan: DryRunToolPlan[];
      capped: number;
    }
  | { type: 'tool_approval_required'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_approval_response'; toolCallId: string; approved: boolean; reason?: string }
  | {
      type: 'evaluators_complete';
      results: Array<{ name: string; pass: boolean; reason?: string; score?: number }>;
    }
  | {
      type: 'credential_required';
      pluginId: string;
      credentialKey: string;
      kind: 'oauth' | 'api_key' | 'text';
      label: string;
      description?: string;
      authUrl?: string;
      sessionKey: string;
      pendingUserMessage: string;
    }
  | {
      type: 'notification_received';
      pluginId: string;
      sessionKey: string;
      message: string;
      startTurn: boolean;
      payload?: Record<string, unknown>;
    };
