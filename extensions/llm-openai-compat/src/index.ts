import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  ProviderCapabilities,
  ToolDefinitionLite,
  ToolOrder,
} from '@ethosagent/types';
import { orderToolDefinitions } from '@ethosagent/types';
import OpenAI from 'openai';
import { parseThinkBlocks, withReasoningOnlyRetry } from './reasoning';
import { classifyLocalRuntime, type LocalOpenAiRuntime } from './runtime-classify';
import { detectTextToolCalls } from './text-tool-call-detect';
import { streamTextToolCalls } from './text-tool-call-transport';
import { buildChatCompletionsParamsAsync, streamChatCompletions } from './transport';

export { parseThinkBlocks, withReasoningOnlyRetry } from './reasoning';
export type { LocalOpenAiRuntime } from './runtime-classify';
export { classifyLocalRuntime, HOSTED_PROVIDER_ALIASES } from './runtime-classify';
export type { SanitizedToolSchema } from './schema-sanitize';
export { GRAMMAR_MAX_LENGTH_CLAMP, sanitizeToolSchemaForGrammar } from './schema-sanitize';
export { detectTextToolCalls, parseStructuralToolCall } from './text-tool-call-detect';
export { streamTextToolCalls } from './text-tool-call-transport';
export type { ChatCompletionsStreamParams } from './transport';
export {
  buildChatCompletionsParams,
  buildChatCompletionsParamsAsync,
  streamChatCompletions,
} from './transport';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OpenAICompatProviderConfig {
  name: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  maxContextTokens?: number;
  toolCallFormat?: 'openai' | 'text-xml';
  /** §7 — default output-token cap applied when the completion does not set
   *  `maxTokens`. A per-call `maxTokens` always wins. */
  maxOutputTokens?: number;
  /** §3 — when true, the provider advertises `capabilities.structuredOutput`
   *  so internal JSON consumers request grammar-constrained decoding. Absent →
   *  capability stays unset. */
  structuredOutput?: boolean;
  /** Lane 2a — tool-definition ordering at the serialization boundary.
   *  Default `'stable'` (deterministic ASCII sort). `'insertion'` is a
   *  temporary rollback lever; removal tracked in plan/uncompleted-tasks.md. */
  toolOrder?: ToolOrder;
  /** Test seam — custom fetch handed to the OpenAI SDK client. Used by the
   *  golden request-body harness to capture exact wire bytes. Absent → the
   *  SDK's default fetch. */
  fetchImpl?: typeof globalThis.fetch;
  /** Lane 4a(d) — per-request deadline in milliseconds, handed to the OpenAI
   *  SDK client. Absent → the SDK's own default (10 minutes). The default
   *  stays deliberately LONG: a cold local model load (Ollama pulling weights
   *  into RAM/VRAM) legitimately takes minutes, and a short default would
   *  break the first turn on every fresh server start. */
  requestTimeoutMs?: number;
  /** Lane 4a(d) — retry count handed to the OpenAI SDK client. Absent → the
   *  SDK's own default (2 retries). */
  maxRetries?: number;
  /** Lane 3(a) — tool-schema sanitizing for llamacpp-class grammar compilers
   *  (llama.cpp server, Ollama, LM Studio — GBNF). Wiring sets this from Lane
   *  0's `detectLocalRuntime`; the OpenClaw equivalent is
   *  `compat.toolSchemaProfile: "llamacpp"`. Absent → schemas pass through
   *  UNTOUCHED (hosted OpenAI-compat dialects are never sanitized). */
  toolSchemaProfile?: 'llamacpp';
  /** Lane 3(a) — diagnostics sink for sanitizer transformations (the Lane 0
   *  logger.warn path, threaded by the factory). Each unique change is
   *  reported ONCE per provider instance — tool payloads repeat on every
   *  request, and a per-request repeat would be log spam. */
  onDiagnostic?: (message: string) => void;
  /** Post-review FIX 5 — explicit override for `<think>…</think>` TAG parsing
   *  in the text stream. Absent → derived from the hardened local-runtime
   *  classification (local → parse, hosted → pass through verbatim). Set
   *  `true` in a model profile to opt a hosted reasoning model in. */
  parseThinkTags?: boolean;
}

/**
 * §3 — pick the request dialect for grammar-constrained JSON. The three
 * OpenAI-compat families phrase structured output differently:
 *   - openai (default): `response_format: { type: 'json_schema', json_schema }`
 *   - ollama:           top-level `format` accepts a JSON schema
 *   - vllm:             `guided_json` guided-decoding param
 * Derived from the provider name (the configured alias) plus Ollama's
 * distinctive default port. Only ever consumed when a caller sets
 * `providerOptions['openai-compat'].responseFormat` — no effect otherwise.
 */
// Phase 1d — documented floor for agentic tool use on local backends. Below
// this, tool schemas + a single turn already overflow, and Ollama/vLLM truncate
// silently. Surfaced as a loud constructor error instead.
const LOCAL_CONTEXT_FLOOR_TOKENS = 16_000;

function detectStructuredOutputDialect(
  name: string,
  baseUrl: string,
): 'openai' | 'ollama' | 'vllm' {
  // Post-review FIX 2 — consult the hardened local-runtime classification
  // instead of a raw port check: a known hosted alias (openrouter/groq/…)
  // proxied on :11434 must NEVER get the ollama dialect. Generic names on
  // local ports and the 'ollama'/'vllm' aliases classify as before; the
  // lmstudio/llamacpp classifications fall through to the 'openai'
  // response-format dialect (unchanged).
  const runtime = classifyLocalRuntime(name, baseUrl);
  if (runtime === 'ollama') return 'ollama';
  if (runtime === 'vllm') return 'vllm';
  return 'openai';
}

// ---------------------------------------------------------------------------
// Gemini schema normalization
// Gemini via OpenAI-compat rejects several JSON Schema fields that OpenAI allows.
// ---------------------------------------------------------------------------

const GEMINI_STRIP_KEYS = new Set([
  'minLength',
  'maxLength',
  'pattern',
  'format',
  '$schema',
  'additionalProperties',
]);

export function normalizeGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(schema)) {
    if (GEMINI_STRIP_KEYS.has(k)) continue;

    // Gemini doesn't support array `type` (e.g. ["string", "null"])
    if (k === 'type' && Array.isArray(v)) {
      // Take the first non-null type
      const nonNull = (v as string[]).find((t) => t !== 'null');
      if (nonNull) out.type = nonNull;
      continue;
    }

    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = normalizeGeminiSchema(v as Record<string, unknown>);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? normalizeGeminiSchema(item as Record<string, unknown>)
          : item,
      );
    } else {
      out[k] = v;
    }
  }

  return out;
}

function isGeminiEndpoint(baseUrl: string): boolean {
  return baseUrl.includes('generativelanguage.googleapis.com');
}

// ---------------------------------------------------------------------------
// Message conversion: our Message[] → OpenAI ChatCompletionMessageParam[]
// ---------------------------------------------------------------------------

// Exported for adapter tests — pure function over Message[] with no side effects.
export function toOpenAIMessages(
  messages: Message[],
  system?: string,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  if (system) {
    result.push({ role: 'system', content: system });
  }

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    // MessageContent[] — split into OpenAI format
    if (msg.role === 'user') {
      // Collect tool_result blocks as tool messages
      const toolResults: Array<{ tool_call_id: string; content: string }> = [];
      const textParts: string[] = [];
      // Vision / document parts (OpenAI Chat Completions multipart content).
      const mediaParts: OpenAI.Chat.ChatCompletionContentPart[] = [];

      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          toolResults.push({ tool_call_id: block.tool_use_id, content: block.content });
        } else if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'image') {
          // OpenAI Chat Completions vision: data: URI inside image_url.
          mediaParts.push({
            type: 'image_url',
            image_url: { url: `data:${block.mediaType};base64,${block.data}` },
          });
        } else if (block.type === 'document') {
          // OpenAI Chat Completions PDF: `file` content part with base64
          // file_data + filename. Documented for the OpenAI API itself; some
          // OpenAI-compat backends (Ollama, older Gemini surfaces) reject it
          // — the capability table in vision_analyze (P2) gates by provider.
          mediaParts.push({
            type: 'file',
            file: {
              file_data: `data:${block.mediaType};base64,${block.data}`,
              filename: 'document.pdf',
            },
          });
        }
      }

      // User content: if any media is present we MUST emit a multipart array
      // because OpenAI rejects an image_url block inside a plain string.
      if (mediaParts.length > 0) {
        const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
        for (const t of textParts) parts.push({ type: 'text', text: t });
        for (const m of mediaParts) parts.push(m);
        result.push({ role: 'user', content: parts });
      } else if (textParts.length > 0) {
        result.push({ role: 'user', content: textParts.join('\n') });
      }

      // Tool results as separate tool messages
      for (const tr of toolResults) {
        result.push({ role: 'tool', tool_call_id: tr.tool_call_id, content: tr.content });
      }
    } else {
      // assistant — may have text + tool_use blocks
      const textParts: string[] = [];
      const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          });
        }
      }

      result.push({
        role: 'assistant',
        content: textParts.join('\n') || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// OpenAICompatProvider
// ---------------------------------------------------------------------------

export class OpenAICompatProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly maxContextTokens: number;
  readonly supportsCaching = false;
  /** Lane 4b(b) — the transport passes reasoning through as thinking_delta
   *  (`delta.reasoning_content` / `delta.reasoning` / balanced `<think>`
   *  blocks), so the provider truthfully advertises thinking support. */
  readonly supportsThinking = true;
  readonly supportsVision = { images: true, documents: false };
  readonly supportsCacheBreakpoints = false;
  readonly supportsTokenCounting: 'real' | 'estimated' = 'estimated';

  get capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: true,
      parallelToolCalls: true,
      visionImages: true,
      thinking: true,
      promptCaching: false,
      systemPromptStyle: 'system-role',
      tokenCounting: 'estimated',
      contractVersion: 1,
      // §3 — profile-driven. Absent → key omitted → capability stays unset.
      ...(this.structuredOutput !== undefined ? { structuredOutput: this.structuredOutput } : {}),
    };
  }

  private readonly client: OpenAI;
  private readonly gemini: boolean;
  private readonly azure: boolean;
  /** Effective tool-call transport (§7 profile / config). Public for
   *  observability + wiring tests; defaults to `'openai'`. */
  readonly toolCallFormat: 'openai' | 'text-xml';
  /** §7 profile output-token default; undefined when unset. Public for
   *  observability + wiring tests. */
  readonly maxOutputTokens?: number;
  /** §3 profile structured-output flag; surfaces via `capabilities`. Undefined
   *  when unset. Public for wiring tests. */
  readonly structuredOutput?: boolean;
  /** §3 request dialect for grammar-constrained JSON (openai/ollama/vllm). */
  private readonly structuredOutputDialect: 'openai' | 'ollama' | 'vllm';
  /** Lane 2a — tool-definition ordering at the serialization boundary. */
  private readonly toolOrder: ToolOrder;
  /** Lane 3(a) — llamacpp-class schema sanitizing; undefined → passthrough.
   *  Public for wiring tests. */
  readonly toolSchemaProfile?: 'llamacpp';
  /** Post-review FIX 2/6 — hardened local-runtime classification of this
   *  endpoint (known hosted aliases never classify local, regardless of
   *  port). Gates the 16k floor, the local sampling extras, and FIX 5's
   *  <think>-tag parsing. Public for wiring tests. */
  readonly localRuntime?: LocalOpenAiRuntime;
  /** Post-review FIX 5 — whether `<think>…</think>` TAGS in the text stream
   *  are parsed into thinking_delta. LOCAL-GATED POLICY (plan §2:
   *  off-unless-declared): hosted models legitimately emit balanced <think>
   *  in visible text and it must reach the user verbatim. Contrast with the
   *  `delta.reasoning_content` / `delta.reasoning` FIELD passthrough in
   *  transport.ts, which stays universal — a field the server explicitly
   *  labels as reasoning is structural, and passing it through cures the
   *  empty-turn bug class. Field = bugfix; tag-parsing = local-gated policy. */
  readonly parseThinkTags: boolean;
  /** Lane 3(a) — sanitizer diagnostics sink. */
  private readonly onDiagnostic?: (message: string) => void;
  /** Lane 3(a) — change lines already reported (once per instance). */
  private readonly reportedSchemaChanges = new Set<string>();
  /** Lane 4b(f) — models latched to the text-xml transport after a confirmed
   *  text tool call. PROCESS-LIFETIME ONLY (eng review D18): instance state,
   *  no persistence, no state file — wiring constructs one provider per
   *  process, so the latch dies with the process. The latch log recommends
   *  `toolCallFormat: 'text-xml'` in a model profile for permanence. */
  private readonly textToolCallLatchedModels = new Set<string>();
  /** Lane 4b(f) — detections awaiting dispatch confirmation (D11: latch only
   *  after the parsed call executed OK). Keyed by effective model. */
  private readonly pendingTextToolCallLatches = new Map<
    string,
    { toolCallId: string; triggerText: string }
  >();
  /** Lane 4b(f) — per-instance seed keeping synthesized tool-call ids from
   *  colliding with ids persisted by an earlier process in the same session. */
  private readonly textToolCallIdSeed = Math.random().toString(36).slice(2, 8);
  private textToolCallCounter = 0;

  constructor(config: OpenAICompatProviderConfig) {
    this.name = config.name;
    this.model = config.model;
    this.maxContextTokens = config.maxContextTokens ?? 128_000;
    this.gemini = isGeminiEndpoint(config.baseUrl);
    this.azure = config.baseUrl.includes('azure.com');
    this.toolCallFormat = config.toolCallFormat ?? 'openai';
    this.maxOutputTokens = config.maxOutputTokens;
    this.structuredOutput = config.structuredOutput;
    this.structuredOutputDialect = detectStructuredOutputDialect(config.name, config.baseUrl);
    this.toolOrder = config.toolOrder ?? 'stable';
    if (config.toolSchemaProfile !== undefined) this.toolSchemaProfile = config.toolSchemaProfile;
    if (config.onDiagnostic !== undefined) this.onDiagnostic = config.onDiagnostic;
    const localRuntime = classifyLocalRuntime(config.name, config.baseUrl);
    if (localRuntime !== undefined) this.localRuntime = localRuntime;
    this.parseThinkTags = config.parseThinkTags ?? localRuntime !== undefined;

    // Phase 1d — local-model context floor. Ollama silently truncates at its
    // default `num_ctx` (2–4k) and vLLM can be launched with a small
    // `--max-model-len`; agentic tool use needs a documented 16k floor. When a
    // local backend reports an effective window below the floor, fail LOUDLY at
    // init rather than letting the server silently drop the prompt mid-session.
    // Post-review FIX 6/2 — gated on the hardened local classification: LM
    // Studio (:1234) and llama.cpp (:8080) get the floor too, and a hosted
    // alias behind a proxy on a local port never does.
    if (localRuntime !== undefined && this.maxContextTokens < LOCAL_CONTEXT_FLOOR_TOKENS) {
      throw new Error(
        `${config.name}: effective context window ${this.maxContextTokens} tokens is below the ` +
          `${LOCAL_CONTEXT_FLOOR_TOKENS}-token floor required for agentic tool use. ` +
          `Raise the model's num_ctx / --max-model-len (or its catalog contextWindow) to at least ` +
          `${LOCAL_CONTEXT_FLOOR_TOKENS}.`,
      );
    }

    const baseURL = this.azure
      ? `${config.baseUrl.replace(/\/$/, '')}/openai/deployments/${config.model}`
      : config.baseUrl;

    // Lane 4a(d) — timeout/retries are set ONLY when configured. With neither
    // key present the constructed client inherits the SDK defaults unchanged
    // (10-minute timeout, 2 retries) — asserted by client-timeout.test.ts —
    // so an unconfigured hosted provider sees no latency or retry change.
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL,
      ...(config.requestTimeoutMs !== undefined ? { timeout: config.requestTimeoutMs } : {}),
      ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
      ...(config.fetchImpl ? { fetch: config.fetchImpl } : {}),
      ...(this.azure
        ? {
            defaultQuery: { 'api-version': '2024-08-01-preview' },
            defaultHeaders: { 'api-key': config.apiKey },
          }
        : {}),
    });
  }

  async *complete(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk> {
    // §7 — apply the profile's output-token default only when the caller did
    // not set maxTokens (a per-call maxTokens always wins).
    const effectiveOptions: CompletionOptions =
      options.maxTokens === undefined && this.maxOutputTokens !== undefined
        ? { ...options, maxTokens: this.maxOutputTokens }
        : options;
    const params = await buildChatCompletionsParamsAsync(
      messages,
      tools,
      effectiveOptions,
      this.model,
      {
        gemini: this.gemini,
        countTokens: (msgs) => this.countTokens(msgs),
        structuredOutputDialect: this.structuredOutputDialect,
        // FIX 6 — hardened local classification for the sampling extras
        // (top_k/min_p on lmstudio/llamacpp too, never on hosted aliases).
        ...(this.localRuntime !== undefined ? { localRuntime: this.localRuntime } : {}),
        toolOrder: this.toolOrder,
        // Lane 3(a) — llamacpp-class grammar sanitizing, dialect-gated.
        // Each transformation is logged ONCE per provider instance via the
        // Lane 0 diagnostics path (never silent, never per-request spam).
        ...(this.toolSchemaProfile !== undefined
          ? {
              toolSchemaProfile: this.toolSchemaProfile,
              onSchemaChange: (message: string) => {
                if (this.reportedSchemaChanges.has(message)) return;
                this.reportedSchemaChanges.add(message);
                this.onDiagnostic?.(`tool-schema sanitizer (${this.name}): ${message}`);
              },
            }
          : {}),
      },
    );

    // Lane 4b(f) — settle a pending latch from a previous call: the parsed
    // text tool call's result is now in the history if the loop dispatched it.
    this.resolvePendingTextToolCallLatch(params.effectiveModel, messages);

    const useTextXml =
      this.toolCallFormat === 'text-xml' ||
      this.textToolCallLatchedModels.has(params.effectiveModel);

    if (useTextXml) {
      // Strip structured tools so the model uses text-based XML tool calls
      const paramsNoTools = {
        ...params,
        oaiParams: { ...params.oaiParams, tools: undefined },
      };

      // Inject tool definitions into the system prompt so the model knows
      // what tools are available and how to invoke them via text XML.
      if (tools.length > 0) {
        // Lane 2a — same deterministic ordering as the structured-tools path:
        // the docs land in the request prefix, so they must be byte-stable
        // across restarts. Caching device, not a priority signal.
        const toolDocs = orderToolDefinitions(tools, this.toolOrder)
          .map(
            (t) =>
              `<tool>\n  <name>${t.name}</name>\n  <description>${t.description}</description>\n  <parameters>${JSON.stringify(t.parameters)}</parameters>\n</tool>`,
          )
          .join('\n');
        const toolPrompt = `\n\nYou have access to the following tools:\n<tools>\n${toolDocs}\n</tools>\n\nTo use a tool, output:\n<tool_call>\n{"name": "<tool_name>", "arguments": {<args>}}\n</tool_call>`;

        const existingSystem = paramsNoTools.oaiParams.messages.find((m) => m.role === 'system');
        if (
          existingSystem &&
          'content' in existingSystem &&
          typeof existingSystem.content === 'string'
        ) {
          existingSystem.content += toolPrompt;
        } else {
          paramsNoTools.oaiParams.messages.unshift({
            role: 'system',
            content: toolPrompt,
          });
        }
      }

      // Lane 4b(b) — <think> stripping (FIX 5: local-gated, see
      // `parseThinkTags`) and the reasoning-only retry apply on this path too
      // (reasoning models are the text-xml path's main users).
      yield* withReasoningOnlyRetry(
        () =>
          streamTextToolCalls(
            this.maybeParseThinkTags(
              streamChatCompletions(this.client, paramsNoTools, options.abortSignal),
            ),
          ),
        params.effectiveModel,
        this.onDiagnostic,
      );
    } else {
      const knownToolNames = new Set(tools.map((t) => t.name));
      const makeAttempt = (): AsyncIterable<CompletionChunk> => {
        const base = this.maybeParseThinkTags(
          streamChatCompletions(this.client, params, options.abortSignal),
        );
        // Lane 4b(f) — watch stop-turns for tool calls emitted as text. Only
        // meaningful when tools were offered; the conversion feeds the latch.
        if (knownToolNames.size === 0) return base;
        return detectTextToolCalls(base, knownToolNames, {
          nextToolCallId: () =>
            `text-fallback-${this.textToolCallIdSeed}-${this.textToolCallCounter++}`,
          onDetect: (detection) => {
            this.pendingTextToolCallLatches.set(params.effectiveModel, {
              toolCallId: detection.toolCallId,
              triggerText: detection.triggerText,
            });
          },
        });
      };
      yield* withReasoningOnlyRetry(makeAttempt, params.effectiveModel, this.onDiagnostic);
    }
  }

  /** FIX 5 — apply `<think>`-TAG parsing only where it is policy (local
   *  runtimes, or an explicit `parseThinkTags` opt-in). Hosted streams pass
   *  through untouched so legitimate balanced `<think>` text is preserved
   *  verbatim. The reasoning FIELD passthrough in transport.ts is separate
   *  and universal (see the `parseThinkTags` doc for the split). */
  private maybeParseThinkTags(
    stream: AsyncIterable<CompletionChunk>,
  ): AsyncIterable<CompletionChunk> {
    return this.parseThinkTags ? parseThinkBlocks(stream) : stream;
  }

  /** Lane 4b(f) — flip (or discard) a pending text-tool-call latch based on
   *  the dispatch outcome now visible in the message history. A tool_result
   *  with `is_error` unset means the loop executed the parsed call OK →
   *  latch; `is_error: true` means dispatch failed → no latch (D11). */
  private resolvePendingTextToolCallLatch(effectiveModel: string, messages: Message[]): void {
    const pending = this.pendingTextToolCallLatches.get(effectiveModel);
    if (!pending) return;
    for (const msg of messages) {
      if (typeof msg.content === 'string') continue;
      for (const block of msg.content) {
        if (block.type !== 'tool_result' || block.tool_use_id !== pending.toolCallId) continue;
        this.pendingTextToolCallLatches.delete(effectiveModel);
        if (block.is_error === true) return;
        this.textToolCallLatchedModels.add(effectiveModel);
        const trigger =
          pending.triggerText.length > 500
            ? `${pending.triggerText.slice(0, 500)}…`
            : pending.triggerText;
        this.onDiagnostic?.(
          `text tool-call latch (${this.name}): model ${effectiveModel} emitted a tool call ` +
            `as text and the parsed call dispatched OK — using the text-xml transport for ` +
            `the remainder of this process. For permanence, set toolCallFormat: 'text-xml' ` +
            `in a model profile for ${effectiveModel}. Triggering text: ${trigger}`,
        );
        return;
      }
    }
  }

  async countTokens(messages: Message[]): Promise<number> {
    // OpenAI-compat providers don't expose a token-count endpoint.
    // Rough approximation: 1 token ≈ 4 chars.
    const chars = messages.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return sum + content.length;
    }, 0);
    return Math.ceil(chars / 4);
  }
}

// ---------------------------------------------------------------------------
// First-party plugin activation (§9.2 — dogfooding the plugin SDK)
// ---------------------------------------------------------------------------

import type {
  EthosPluginApi,
  LLMProviderFactory,
  LLMProviderFactoryContext,
} from '@ethosagent/plugin-sdk';

export const PROVIDER_CONTRACT_MAJOR = 3;

export const openaiCompatFactory: LLMProviderFactory = async ({
  config: cfg,
  secrets,
  logger,
}: LLMProviderFactoryContext) => {
  const providerName = (cfg.provider as string) ?? 'openai-compat';
  const baseUrl = (cfg.baseUrl as string) ?? 'https://openrouter.ai/api/v1';
  const secretKey = await secrets.get(`providers/${providerName}/apiKey`);
  const apiKey = secretKey ?? (cfg.apiKey as string);
  if (secretKey === null && cfg.apiKey) {
    logger.warn(
      `Using plaintext apiKey from config for ${providerName}; migrate to the secret store: ethos secrets set providers/${providerName}/apiKey <key>`,
    );
  }
  // Lane 0 — make the 16k floor meaningful on UNKNOWN windows. When no window
  // was resolved (no config, no probe, no catalog), the constructor below
  // defaults maxContextTokens to 128,000, which sails over the floor check
  // while the local server may really be serving 4,096 and silently dropping
  // the front of the prompt. The floor protects a window that resolved SMALL;
  // this diagnostic covers the more dangerous case — a window that never
  // resolved at all. Warn, do not throw (warn-first release).
  // Post-review FIX 6 — gated on the hardened local classification, so
  // lmstudio/llamacpp configs get the warning too and hosted aliases never
  // do. FIX 8 — wiring's window resolution emits the same diagnostic when it
  // runs; it sets `windowResolutionDiagnosed` so the condition logs exactly
  // ONE warning, from whichever path saw it.
  if (typeof cfg.maxContextTokens !== 'number' && cfg.windowResolutionDiagnosed !== true) {
    if (classifyLocalRuntime(providerName, baseUrl) !== undefined) {
      logger.warn(
        `window for ${cfg.model as string} on ${providerName} is unknown; assuming 128000 — ` +
          `set contextWindow in ~/.ethos/config.yaml (or raise num_ctx / --max-model-len so ` +
          `the probe can see the served window)`,
      );
    }
  }
  return new OpenAICompatProvider({
    name: providerName,
    model: cfg.model as string,
    apiKey,
    baseUrl,
    // M1b — honor a context window resolved by wiring (from the model catalog)
    // so a small local model reports its real window to compaction instead of
    // the 128k default. Absent → the provider default still applies.
    ...(typeof cfg.maxContextTokens === 'number' ? { maxContextTokens: cfg.maxContextTokens } : {}),
    // §7 — provider-facing profile fields threaded by wiring. Absent → defaults.
    ...(cfg.toolCallFormat === 'openai' || cfg.toolCallFormat === 'text-xml'
      ? { toolCallFormat: cfg.toolCallFormat }
      : {}),
    ...(typeof cfg.maxOutputTokens === 'number' ? { maxOutputTokens: cfg.maxOutputTokens } : {}),
    ...(typeof cfg.structuredOutput === 'boolean'
      ? { structuredOutput: cfg.structuredOutput }
      : {}),
    // Lane 2a — tool-ordering escape hatch threaded from config; invalid
    // values fall through to the 'stable' default.
    ...(cfg.toolOrder === 'insertion' || cfg.toolOrder === 'stable'
      ? { toolOrder: cfg.toolOrder }
      : {}),
    // Lane 4a(d) — request deadline + retry count threaded from config. Absent
    // → the OpenAI SDK defaults (10-minute timeout, 2 retries) stay in force.
    ...(typeof cfg.requestTimeoutMs === 'number' ? { requestTimeoutMs: cfg.requestTimeoutMs } : {}),
    ...(typeof cfg.maxRetries === 'number' ? { maxRetries: cfg.maxRetries } : {}),
    // Lane 3(a) — llamacpp-class schema-sanitizer gate, set by wiring from
    // Lane 0's detectLocalRuntime. Absent → schemas pass through untouched.
    // Sanitizer transformations surface on the same logger path Lane 0 uses.
    ...(cfg.toolSchemaProfile === 'llamacpp' ? { toolSchemaProfile: 'llamacpp' as const } : {}),
    // FIX 5 — explicit <think>-tag parsing override (model-profile opt-in for
    // hosted reasoning models). Absent → the constructor derives it from the
    // hardened local classification.
    ...(typeof cfg.parseThinkTags === 'boolean' ? { parseThinkTags: cfg.parseThinkTags } : {}),
    onDiagnostic: (message: string) => logger.warn(message),
  });
};

export const OPENAI_COMPAT_ALIASES = [
  'openai',
  'openrouter',
  'gemini',
  'groq',
  'deepseek',
  'ollama',
  'vllm',
] as const;

export function activate(api: EthosPluginApi): void {
  api.registerLLMProvider('openai-compat', openaiCompatFactory);
  for (const id of OPENAI_COMPAT_ALIASES) {
    api.registerLLMProvider(id, openaiCompatFactory);
  }
}
