import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
  ApprovalScopeSchema,
  OnboardingStepSchema,
  PersonalitySchema,
  ProviderIdSchema,
  SessionSchema,
  StoredMessageSchema,
} from './schemas';

// oRPC contract — single source of truth for the web control plane.
// `extensions/web-api` (server) calls `implement(contract)` against this.
// `apps/web` (client) calls `createORPCClient(link)` typed as
// `ContractRouterClient<typeof contract>`. Both ends fail to compile if the
// shapes drift.
//
// v0 surface: sessions / personalities (read-only) / chat / tools /
// onboarding / config. v0.5 (cron, skills, mesh) and v1 (memory, comms,
// plugins, settings, batch, eval) namespaces land in their own phases.

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const SessionListInput = z.object({
  /** Full-text query (FTS5). Empty / omitted returns recent sessions. */
  q: z.string().optional(),
  /** Page size; max 200 to keep payloads bounded. */
  limit: z.number().int().min(1).max(200).optional(),
  /** Opaque rowid cursor from the previous response's `nextCursor`. */
  cursor: z.string().nullable().optional(),
  personalityId: z.string().optional(),
});
const SessionListOutput = z.object({
  sessions: z.array(SessionSchema),
  nextCursor: z.string().nullable(),
});

const SessionGetInput = z.object({ id: z.string() });
const SessionGetOutput = z.object({
  session: SessionSchema,
  messages: z.array(StoredMessageSchema),
});

const SessionForkInput = z.object({
  id: z.string(),
  personalityId: z.string().optional(),
});
const SessionForkOutput = z.object({ session: SessionSchema });

const SessionDeleteInput = z.object({ id: z.string() });
const SessionDeleteOutput = z.object({ ok: z.literal(true) });

const sessions = {
  list: oc.input(SessionListInput).output(SessionListOutput),
  get: oc.input(SessionGetInput).output(SessionGetOutput),
  fork: oc.input(SessionForkInput).output(SessionForkOutput),
  delete: oc.input(SessionDeleteInput).output(SessionDeleteOutput),
};

// ---------------------------------------------------------------------------
// Personalities (v0 read-only — create/edit lands in v1)
// ---------------------------------------------------------------------------

const PersonalityListOutput = z.object({
  personalities: z.array(PersonalitySchema),
  defaultId: z.string(),
});
const PersonalityGetInput = z.object({ id: z.string() });
const PersonalityGetOutput = z.object({
  personality: PersonalitySchema,
  /** Markdown body of ETHOS.md. Empty string when the file isn't present. */
  ethosMd: z.string(),
});

const personalities = {
  list: oc.output(PersonalityListOutput),
  get: oc.input(PersonalityGetInput).output(PersonalityGetOutput),
};

// ---------------------------------------------------------------------------
// Chat
//
// `chat.send` is fire-and-(quickly)-forget — it returns once the turn has
// been kicked off on the server. The agent's actual response streams over
// SSE on `/sse/sessions/:sessionId`. `clientId` distinguishes multiple
// browser tabs writing to the same session (CEO finding 4.1).
// ---------------------------------------------------------------------------

const ChatSendInput = z.object({
  /** Existing session ID, or omit to start a new session. */
  sessionId: z.string().optional(),
  clientId: z.string().min(1),
  text: z.string().min(1),
  personalityId: z.string().optional(),
});
const ChatSendOutput = z.object({
  sessionId: z.string(),
  /** Echoed back so a tab knows which turn the SSE stream belongs to. */
  turnId: z.string(),
});

const ChatAbortInput = z.object({ sessionId: z.string() });
const ChatAbortOutput = z.object({ ok: z.literal(true) });

const chat = {
  send: oc.input(ChatSendInput).output(ChatSendOutput),
  abort: oc.input(ChatAbortInput).output(ChatAbortOutput),
};

// ---------------------------------------------------------------------------
// Tools — approval workflow for dangerous tool calls
// ---------------------------------------------------------------------------

const ToolApproveInput = z.object({
  approvalId: z.string(),
  scope: ApprovalScopeSchema,
});
const ToolApproveOutput = z.object({ ok: z.literal(true) });

const ToolDenyInput = z.object({
  approvalId: z.string(),
  reason: z.string().optional(),
});
const ToolDenyOutput = z.object({ ok: z.literal(true) });

const tools = {
  approve: oc.input(ToolApproveInput).output(ToolApproveOutput),
  deny: oc.input(ToolDenyInput).output(ToolDenyOutput),
};

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

const OnboardingStateOutput = z.object({
  step: OnboardingStepSchema,
  /** True once `~/.ethos/config.yaml` has a valid provider + key. */
  hasProvider: z.boolean(),
  /** Set after step 3. */
  selectedPersonalityId: z.string().nullable(),
});

const OnboardingValidateProviderInput = z.object({
  provider: ProviderIdSchema,
  apiKey: z.string().min(1),
  baseUrl: z.string().optional(),
});
const OnboardingValidateProviderOutput = z.object({
  ok: z.boolean(),
  /** Models returned by the provider's catalog endpoint when validation succeeds. */
  models: z.array(z.string()).nullable(),
  error: z.string().nullable(),
});

const OnboardingCompleteInput = z.object({
  provider: ProviderIdSchema,
  model: z.string().min(1),
  apiKey: z.string().min(1),
  baseUrl: z.string().optional(),
  personalityId: z.string().min(1),
});
const OnboardingCompleteOutput = z.object({ ok: z.literal(true) });

const onboarding = {
  state: oc.output(OnboardingStateOutput),
  validateProvider: oc
    .input(OnboardingValidateProviderInput)
    .output(OnboardingValidateProviderOutput),
  complete: oc.input(OnboardingCompleteInput).output(OnboardingCompleteOutput),
};

// ---------------------------------------------------------------------------
// Config
//
// Read-only view of the parts of `~/.ethos/config.yaml` the web UI can edit.
// The full file (with raw API keys) never crosses the wire — `apiKey` is
// returned as a redacted preview ("sk-…abc1") so users can confirm which key
// is active without leaking it to the browser.
// ---------------------------------------------------------------------------

const ConfigGetOutput = z.object({
  provider: z.string(),
  model: z.string(),
  apiKeyPreview: z.string(), // e.g. "sk-…abc1"
  baseUrl: z.string().nullable(),
  personality: z.string(),
  memory: z.enum(['markdown', 'vector']),
  modelRouting: z.record(z.string(), z.string()),
});

const ConfigUpdateInput = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  personality: z.string().optional(),
  memory: z.enum(['markdown', 'vector']).optional(),
  modelRouting: z.record(z.string(), z.string()).optional(),
});
const ConfigUpdateOutput = z.object({ ok: z.literal(true) });

const config = {
  get: oc.output(ConfigGetOutput),
  update: oc.input(ConfigUpdateInput).output(ConfigUpdateOutput),
};

// ---------------------------------------------------------------------------
// Root contract — every namespace mounted under one symbol
// ---------------------------------------------------------------------------

export const contract = {
  sessions,
  personalities,
  chat,
  tools,
  onboarding,
  config,
};

export type Contract = typeof contract;
