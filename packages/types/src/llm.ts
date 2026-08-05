export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
  /** Per-slice breakdown of input tokens by request component. */
  requestTokens?: { system: number; tools: number; messages: number };
}

export type CompletionChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_use_start'; toolCallId: string; toolName: string }
  | { type: 'tool_use_delta'; toolCallId: string; partialJson: string }
  | { type: 'tool_use_end'; toolCallId: string; inputJson: string }
  | { type: 'usage'; usage: TokenUsage; metadata?: Record<string, unknown> }
  | { type: 'done'; finishReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' }
  | { type: 'warning'; message: string };

export interface Message {
  role: 'user' | 'assistant';
  content: string | MessageContent[];
}

export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  // Vision / document blocks. Carried as base64 strings rather than Buffer
  // because @ethosagent/types is zero-dep and the underlying SDKs (Anthropic,
  // OpenAI) ultimately want base64 strings on the wire. The tool that
  // produces these (vision_analyze) encodes once at construction time.
  | {
      type: 'image';
      mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
      data: string;
    }
  | { type: 'document'; mediaType: 'application/pdf'; data: string };

export interface CompletionOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  seed?: number;
  thinkingBudget?: number;
  cacheSystemPrompt?: boolean;
  abortSignal?: AbortSignal;
  stopSequences?: string[];
  modelOverride?: string;
  /**
   * context_compression F2 — message-history cache breakpoints. Each number
   * is an index into `messages`; the provider places a `cache_control` marker
   * on that message so the prompt cache survives compaction. Anthropic allows
   * at most 4 breakpoints total (system + messages) — providers cap to the
   * limit and drop the rest. Providers without prompt caching ignore the field.
   *
   * Lane 2c — on local runtimes the equivalent of a cache breakpoint is
   * BYTE-STABILITY of the request prefix, not a marker: vLLM
   * (`--enable-prefix-caching`) and llama.cpp (`--cache-reuse`) hash prefixes,
   * so there is nothing to annotate. Do NOT build an openai-compat consumer
   * for this field — keeping the serialized request byte-stable across turns
   * is what makes their caches hit.
   */
  cacheBreakpoints?: number[];
  /** Namespaced escape hatch for provider-specific options. Keys are provider
   *  names (e.g. `anthropic`, `openai`), values are provider-specific option
   *  bags. Example: `{ anthropic: { thinkingBudget: 10000 } }`. */
  providerOptions?: Record<string, Record<string, unknown>>;
}

/**
 * §3 — build the `providerOptions` bag that requests grammar-constrained JSON
 * output for a given JSON Schema, so callers don't hand-assemble the nested
 * shape. Merge the result into `CompletionOptions.providerOptions`. The
 * openai-compat transport reads `providerOptions['openai-compat'].responseFormat`
 * and maps it to the provider dialect (`response_format` json_schema / Ollama
 * `format` / vLLM `guided_json`). Only consume this when the provider declares
 * `capabilities.structuredOutput` — models without it ignore the field.
 */
export function structuredOutputOption(
  schema: Record<string, unknown>,
  opts?: { name?: string; strict?: boolean },
): Record<string, Record<string, unknown>> {
  return {
    'openai-compat': {
      responseFormat: {
        name: opts?.name ?? 'response',
        strict: opts?.strict ?? true,
        schema,
      },
    },
  };
}

export interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  parallelToolCalls?: boolean;
  visionImages?: boolean;
  visionDocuments?: boolean;
  audioIn?: boolean;
  structuredOutput?: boolean;
  thinking?: boolean;
  promptCaching?: boolean;
  cacheBreakpoints?: boolean;
  systemPromptStyle?: 'top-level' | 'system-role' | 'developer-role' | 'fold-into-first-user';
  maxInputTokens?: number;
  maxOutputTokens?: number;
  stopSequences?: boolean;
  logprobs?: boolean;
  tokenCounting?: 'real' | 'estimated' | false;
  contractVersion?: number;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly maxContextTokens: number;
  readonly supportsCaching: boolean;
  readonly supportsThinking: boolean;
  supportsVision?: {
    images: boolean;
    documents: boolean;
  };
  supportsCacheBreakpoints?: boolean;
  supportsTokenCounting?: 'real' | 'estimated';
  capabilities?: ProviderCapabilities;
  complete(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk>;
  countTokens(messages: Message[]): Promise<number>;
}

export interface ToolDefinitionLite {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Lane 2a — how a provider orders tool definitions when serializing the
 * request body. `'stable'` (the default) applies the deterministic ASCII
 * ordering below; `'insertion'` preserves registration order (the pre-Lane-2
 * behavior). The escape hatch exists as a temporary rollback lever; removal
 * is tracked in `plan/uncompleted-tasks.md` (eng review D6/D13).
 */
export type ToolOrder = 'insertion' | 'stable';

/**
 * Lane 2a — deterministic ASCII-stable ordering for tool definitions at the
 * provider serialization boundary. Tool definitions ship AHEAD of messages in
 * the request body, so they are part of the cacheable prefix; registration
 * order is not stable across restarts (MCP, plugin, delegation, and goal
 * tools register after loop construction, and MCP server connection order
 * depends on network timing). Sorting by name (raw code-unit comparison — no
 * locale, no collation tables) makes the prefix byte-identical across
 * restarts.
 *
 * The ordering is a CACHING DEVICE, not a priority signal — it carries no
 * semantic meaning and models must not be expected to prefer earlier tools.
 *
 * Applied at the provider boundary, NOT in `ToolRegistry.toDefinitions()`:
 * callers of `toDefinitions` (bench, static estimates) must keep measuring
 * the same set the provider sends, and one sort site per provider keeps one
 * source of truth for what goes on the wire.
 */
export function orderToolDefinitions(
  tools: ToolDefinitionLite[],
  order: ToolOrder = 'stable',
): ToolDefinitionLite[] {
  if (order === 'insertion') return tools;
  return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export interface AuthProfile {
  id: string;
  apiKey: string;
  baseUrl?: string;
  priority: number;
}

export type FailoverReason =
  | 'auth'
  | 'rate_limit'
  | 'overloaded'
  | 'context_overflow'
  | 'timeout'
  | 'network'
  | 'model_not_found'
  | 'content_filter'
  | 'unknown';

// ---------------------------------------------------------------------------
// LLM Provider Registry — pluggable provider factories
// ---------------------------------------------------------------------------

export interface LLMProviderFactoryContext {
  config: Record<string, unknown>;
  secrets: import('./secrets').SecretsResolver;
  logger: import('./logger').Logger;
}

export type LLMProviderFactory = (
  ctx: LLMProviderFactoryContext,
) => LLMProvider | Promise<LLMProvider>;

export interface LLMProviderRegistry {
  register(name: string, factory: LLMProviderFactory): void;
  unregister(name: string): void;
  get(name: string): LLMProviderFactory | undefined;
  list(): string[];
}

// ---------------------------------------------------------------------------
// Config-only provider manifest — Tier 1 (zero-code) authoring
// ---------------------------------------------------------------------------

export interface ConfigOnlyProviderManifest {
  id: string;
  name: string;
  transport: 'openai-chat-completions';
  baseUrl: string;
  auth: {
    location: 'header' | 'query';
    name: string;
    scheme?: 'bearer' | 'raw';
    secretRef: string;
  };
  capabilities: ProviderCapabilities;
  defaultModel?: string;
  models?: string[];
}

// ---------------------------------------------------------------------------
// Auth descriptors — pluggable authentication for LLM providers
// ---------------------------------------------------------------------------

export type AuthLocation = 'header' | 'query';

export interface StaticAuthDescriptor {
  type: 'static';
  location: AuthLocation;
  name: string;
  scheme?: 'bearer' | 'raw';
}

export interface SignerAuthDescriptor {
  type: 'signer';
  signerId: string;
}

export interface GcpOAuthDescriptor {
  type: 'gcp-oauth';
  projectId: string;
  region: string;
}

export type AuthDescriptor = StaticAuthDescriptor | SignerAuthDescriptor | GcpOAuthDescriptor;

export interface AuthSigner {
  sign(request: AuthSignRequest): Promise<AuthSignResult>;
}

export interface AuthSignRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface AuthSignResult {
  headers: Record<string, string>;
  url?: string;
}
