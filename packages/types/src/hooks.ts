import type { PersonalityConfig } from './personality';
import type { InboundMessage, OutboundMessage } from './platform';
import type { StoredMessage } from './session';
import type { ToolResult } from './tool';

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
}

export interface AfterLLMCallPayload {
  sessionId: string;
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface BeforeToolCallPayload {
  sessionId: string;
  toolName: string;
  args: unknown;
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

export interface AgentDonePayload {
  sessionId: string;
  text: string;
  turnCount: number;
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

// ---------------------------------------------------------------------------
// Hook map — groups by execution model
// ---------------------------------------------------------------------------

export interface VoidHooks {
  session_start: SessionStartPayload;
  before_llm_call: BeforeLLMCallPayload;
  after_llm_call: AfterLLMCallPayload;
  after_tool_call: AfterToolCallPayload;
  agent_done: AgentDonePayload;
  message_received: MessageReceivedPayload;
  message_sent: MessageSentPayload;
  subagent_spawned: SubagentSpawnedPayload;
  subagent_ended: SubagentEndedPayload;
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

  fireVoid<K extends keyof VoidHooks>(name: K, payload: VoidHooks[K]): Promise<void>;

  fireModifying<K extends keyof ModifyingHooks>(
    name: K,
    payload: ModifyingHooks[K][0],
  ): Promise<ModifyingHooks[K][1]>;

  fireClaiming<K extends keyof ClaimingHooks>(
    name: K,
    payload: ClaimingHooks[K][0],
  ): Promise<ClaimingHooks[K][1]>;

  unregisterPlugin(pluginId: string): void;
}
