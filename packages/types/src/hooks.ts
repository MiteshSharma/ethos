import type { BackgroundJob } from './background-job';
import type {
  BeforeGoalCompletePayload,
  BeforeGoalCompleteResult,
  GoalCompletedPayload,
  GoalExhaustedPayload,
  GoalFailedPayload,
  GoalNeedsClarificationPayload,
} from './goal';
import type { Message, ToolDefinitionLite } from './llm';
import type { PersonalityConfig } from './personality';
import type { InboundMessage, OutboundMessage } from './platform';
import type { StoredMessage } from './session';
import type { ToolResult } from './tool';
import type { VoiceTurnOrigin } from './voice';

// ---------------------------------------------------------------------------
// Hook payload types
// ---------------------------------------------------------------------------

export interface SessionStartPayload {
  sessionId: string;
  sessionKey: string;
  platform: string;
  personalityId?: string;
}

export interface BeforePromptBuildPayload {
  sessionId: string;
  personalityId?: string;
  history: StoredMessage[];
}

export interface BeforePromptBuildResult {
  prependSystem?: string;
  appendSystem?: string;
  overrideSystem?: string;
}

export interface BeforeLLMCallPayload {
  sessionId: string;
  model: string;
  turnNumber: number;
  system?: string;
  tools?: ToolDefinitionLite[];
  messages?: Message[];
  requestId?: string;
}

export interface AfterLLMCallPayload {
  sessionId: string;
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    estimatedCostUsd?: number;
    requestTokens?: { system: number; tools: number; messages: number };
  };
  requestId?: string;
  finishReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error';
  durationMs?: number;
  system?: string;
  tools?: ToolDefinitionLite[];
  messages?: Message[];
}

export interface BeforeToolCallPayload {
  sessionId: string;
  /** Stable id for the tool_use block this hook is gating. Hooks that need to
   *  surface external state (e.g. an approval modal) key off this id so they
   *  can correlate the response back to the right call. */
  toolCallId: string;
  toolName: string;
  args: unknown;
  /**
   * Set when the turn that produced this call arrived as SPEECH. Absent means
   * the turn was typed — which is the common case, and why this is optional.
   *
   * It rides the payload rather than being looked up from session state
   * because a single session mixes typed and spoken turns: "was this call
   * asked for out loud" is a property of the turn, and only the loop running
   * the turn knows it. The spoken-confirmation gate
   * (`withSpokenConfirmation`, `@ethosagent/wiring`) reads it to require a
   * verbal re-confirmation on high-impact calls, and to refuse outright when
   * `speaker` is `far_end`.
   */
  voiceOrigin?: VoiceTurnOrigin;
}

export interface BeforeToolCallResult {
  args?: unknown;
  error?: string;
}

export interface AfterToolCallPayload {
  sessionId: string;
  toolName: string;
  result: ToolResult;
  durationMs: number;
}

/**
 * E5 — emitted after `tool_end` for any tool whose arguments referenced a
 * filesystem path (`read_file`, `write_file`, `patch_file`, `terminal` with
 * `cwd`, etc.). Subscribers can use this to react to where the agent is
 * navigating — e.g. progressive context-file discovery in a monorepo.
 *
 * `filePath` may be relative (resolved against `workingDir`) or absolute;
 * subscribers should normalize before use. `workingDir` is the AgentLoop's
 * working directory at the time the tool ran.
 */
export interface ToolEndWithPathPayload {
  sessionId: string;
  personalityId?: string;
  toolName: string;
  filePath: string;
  workingDir: string;
}

export interface AgentDonePayload {
  sessionId: string;
  text: string;
  turnCount: number;
  /**
   * E3 — extra metadata used by the skill-evolver auto-trigger to decide
   * whether the turn was substantive enough to queue an analysis. Optional
   * so existing call sites stay unchanged.
   */
  personalityId?: string;
  successfulToolCalls?: number;
  totalToolCalls?: number;
  toolNames?: string[];
  /** First user message of the turn — context for skill candidate analysis. */
  initialPrompt?: string;
  /** Skill markdown filenames active in this turn's system prompt. */
  activeSkillFiles?: string[];
}

export interface MessageReceivedPayload {
  message: InboundMessage;
  sessionId?: string;
}

export interface MessageSendingPayload {
  chatId: string;
  message: OutboundMessage;
}

export interface MessageSendingResult {
  message?: OutboundMessage;
}

export interface MessageSentPayload {
  chatId: string;
  messageId?: string;
}

export interface InboundClaimPayload {
  message: InboundMessage;
}

export interface InboundClaimResult {
  handled: boolean;
}

export interface BeforeDispatchPayload {
  chatId: string;
  platform: string;
  text: string;
}

export interface BeforeDispatchResult {
  handled: boolean;
}

/**
 * Context-economy Phase 1 — fired by the Gateway for every accepted inbound
 * channel message AFTER the bot/lane is resolved but BEFORE an agent turn is
 * enqueued. A handler that returns `{ handled: true }` claims the message:
 * no agent turn runs (zero LLM tokens), and an optional `reply` is sent back
 * through the gateway's normal outbound dedup path.
 *
 * Security stance: `text` is untrusted channel input. Handlers must NEVER
 * interpolate any part of it into shell commands or other privileged sinks —
 * match it exactly against operator-owned config and act on the config, not
 * the text.
 */
export interface GatewayMessagePayload {
  platform: string;
  chatId: string;
  botKey?: string;
  userId?: string;
  text: string;
  isDm: boolean;
}

export interface GatewayMessageResult {
  /** true = this handler claims the message; the gateway skips the agent turn. */
  handled: boolean;
  /** Optional canned reply, sent via the adapter through the outbound dedup gate. */
  reply?: string;
}

export interface BeforeTicketCompletePayload {
  taskId: string;
  /** The completion summary the assignee submitted (the "ticket output" a verifier checks). */
  summary: string;
  /** The ticket's acceptance criteria, if set. */
  acceptanceCriteria?: string;
  /** The assignee's reputation tier, if a trust_policy is configured. */
  autonomyTier?: 'probationary' | 'standard' | 'trusted';
}

export interface BeforeTicketCompleteResult {
  /** true = this handler rejects the completion (the "claiming" semantics: it claims the completion as blocked). */
  handled: boolean;
  /** Why the completion was rejected. Required when handled is true. */
  reason?: string;
}

export interface PersonalitySwitchedPayload {
  sessionId: string;
  from?: string;
  to: string;
}

export interface PersonalitySwitchedResult {
  personality?: PersonalityConfig;
}

export interface SubagentSpawningPayload {
  parentSessionId: string;
  prompt: string;
  personalityId?: string;
}

export interface SubagentSpawningResult {
  prompt?: string;
  personalityId?: string;
}

export interface SubagentSpawnedPayload {
  parentSessionId: string;
  childSessionId: string;
  personalityId?: string;
}

export interface SubagentEndedPayload {
  parentSessionId: string;
  childSessionId: string;
  result: string;
}

export interface AfterTicketRevisionPayload {
  taskId: string;
  summary: string;
  acceptanceCriteria?: string;
  reason: string;
  assignee: string;
  autonomyTier?: 'probationary' | 'standard' | 'trusted';
  successRatio?: number;
}

export interface ProcessCompleteEvent {
  processId: string;
  sessionId: string;
  sessionKey: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Fired by the BackgroundExecutor after EVERY terminal transition of a
 * background job (`done` / `failed` / `aborted`, including the stale→terminal
 * "recovered" case). Carries the final persisted job row; the handler reads
 * status/summary/error/origin* off it and decides whether to surface it (e.g.
 * the gateway stays silent on `aborted`). Suppression is the subscriber's call,
 * not the executor's.
 */
export interface BackgroundJobCompletePayload {
  job: BackgroundJob;
}

// ---------------------------------------------------------------------------
// Hook map — groups by execution model
// ---------------------------------------------------------------------------

export interface VoidHooks {
  session_start: SessionStartPayload;
  before_llm_call: BeforeLLMCallPayload;
  after_llm_call: AfterLLMCallPayload;
  after_tool_call: AfterToolCallPayload;
  tool_end_with_path: ToolEndWithPathPayload;
  agent_done: AgentDonePayload;
  message_received: MessageReceivedPayload;
  message_sent: MessageSentPayload;
  subagent_spawned: SubagentSpawnedPayload;
  subagent_ended: SubagentEndedPayload;
  after_ticket_revision: AfterTicketRevisionPayload;
  process_complete: ProcessCompleteEvent;
  on_background_job_complete: BackgroundJobCompletePayload;
  goal_completed: GoalCompletedPayload;
  goal_failed: GoalFailedPayload;
  goal_exhausted: GoalExhaustedPayload;
  goal_needs_clarification: GoalNeedsClarificationPayload;
}

export interface ModifyingHooks {
  before_prompt_build: [BeforePromptBuildPayload, BeforePromptBuildResult];
  before_tool_call: [BeforeToolCallPayload, BeforeToolCallResult];
  message_sending: [MessageSendingPayload, MessageSendingResult];
  personality_switched: [PersonalitySwitchedPayload, PersonalitySwitchedResult];
  subagent_spawning: [SubagentSpawningPayload, SubagentSpawningResult];
}

export interface ClaimingHooks {
  inbound_claim: [InboundClaimPayload, InboundClaimResult];
  before_dispatch: [BeforeDispatchPayload, BeforeDispatchResult];
  // Deterministic pre-LLM shortcut at the gateway (context-economy Phase 1).
  // First handler to return `{ handled: true }` wins; no handler registered →
  // `fireClaiming` returns `{ handled: false }` and the turn proceeds unchanged.
  gateway_message: [GatewayMessagePayload, GatewayMessageResult];
  // The plan's conceptual `{ rejected: true, reason }` maps onto the existing
  // claiming contract as `{ handled: true, reason }` — `handled: true` means
  // "completion rejected". `fireClaiming` returns `{ handled: false }` when no
  // handler claims, so the completion proceeds (the default no-op behaviour).
  before_ticket_complete: [BeforeTicketCompletePayload, BeforeTicketCompleteResult];
  before_goal_complete: [BeforeGoalCompletePayload, BeforeGoalCompleteResult];
}

export type HookName = keyof VoidHooks | keyof ModifyingHooks | keyof ClaimingHooks;

export interface HookRegistry {
  registerVoid<K extends keyof VoidHooks>(
    name: K,
    handler: (payload: VoidHooks[K]) => Promise<void>,
    opts?: { pluginId?: string; failurePolicy?: 'fail-open' | 'fail-closed' },
  ): () => void;

  registerModifying<K extends keyof ModifyingHooks>(
    name: K,
    handler: (payload: ModifyingHooks[K][0]) => Promise<Partial<ModifyingHooks[K][1]> | null>,
    opts?: { pluginId?: string },
  ): () => void;

  registerClaiming<K extends keyof ClaimingHooks>(
    name: K,
    handler: (payload: ClaimingHooks[K][0]) => Promise<ClaimingHooks[K][1]>,
    opts?: { pluginId?: string },
  ): () => void;

  /**
   * `allowedPlugins` gates which plugin-registered handlers fire:
   *   undefined  → all handlers fire (no personality context / gateway hooks)
   *   []         → only built-in handlers (no pluginId) fire
   *   ['p', …]   → built-in handlers + handlers whose pluginId is in the list
   */
  fireVoid<K extends keyof VoidHooks>(
    name: K,
    payload: VoidHooks[K],
    allowedPlugins?: string[],
  ): Promise<void>;

  fireModifying<K extends keyof ModifyingHooks>(
    name: K,
    payload: ModifyingHooks[K][0],
    allowedPlugins?: string[],
  ): Promise<ModifyingHooks[K][1]>;

  fireClaiming<K extends keyof ClaimingHooks>(
    name: K,
    payload: ClaimingHooks[K][0],
    allowedPlugins?: string[],
  ): Promise<ClaimingHooks[K][1]>;

  unregisterPlugin(pluginId: string): void;

  /**
   * Introspection: is at least one handler registered for `name` under the
   * given execution model? Not an execution model of its own — it exists so a
   * consumer can verify that a declared policy has an implementation behind it
   * (see `ApprovalPosture` in `./safety`) without firing the hook, which would
   * mean invoking real approval logic with a synthetic payload.
   */
  hasHandlers(model: 'void' | 'modifying' | 'claiming', name: HookName): boolean;
}
