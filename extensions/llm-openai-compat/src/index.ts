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
import { streamTextToolCalls } from './text-tool-call-transport';
import { buildChatCompletionsParamsAsync, streamChatCompletions } from './transport';

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
  const n = name.toLowerCase();
  if (n === 'ollama' || baseUrl.includes(':11434')) return 'ollama';
  if (n === 'vllm') return 'vllm';
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
// Per-model pricing (USD per million tokens, approximate)
// ---------------------------------------------------------------------------

const OPENAI_PRICING: Array<{ prefix: string; input: number; output: number }> = [
  // OpenAI
  { prefix: 'gpt-4o-mini', input: 0.15, output: 0.6 },
  { prefix: 'gpt-4o', input: 2.5, output: 10 },
  { prefix: 'gpt-4-turbo', input: 10, output: 30 },
  { prefix: 'gpt-4', input: 30, output: 60 },
  { prefix: 'gpt-3.5-turbo', input: 0.5, output: 1.5 },
  // Google Gemini
  { prefix: 'gemini-2.0-flash', input: 0.1, output: 0.4 },
  { prefix: 'gemini-1.5-flash', input: 0.075, output: 0.3 },
  { prefix: 'gemini-1.5-pro', input: 1.25, output: 5.0 },
  // DeepSeek
  { prefix: 'deepseek-v3', input: 0.14, output: 0.28 },
  { prefix: 'deepseek-r1', input: 0.55, output: 2.19 },
  // Mistral
  { prefix: 'mistral-large', input: 2.0, output: 6.0 },
  { prefix: 'mistral-small', input: 0.1, output: 0.3 },
];

export function estimateCostOpenAI(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = OPENAI_PRICING.find((r) => model.toLowerCase().includes(r.prefix));
  if (!p) return 0; // unknown model — local/Ollama or unrecognised
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

// ---------------------------------------------------------------------------
// OpenAICompatProvider
// ---------------------------------------------------------------------------

export class OpenAICompatProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly maxContextTokens: number;
  readonly supportsCaching = false;
  readonly supportsThinking = false;
  readonly supportsVision = { images: true, documents: false };
  readonly supportsCacheBreakpoints = false;
  readonly supportsTokenCounting: 'real' | 'estimated' = 'estimated';

  get capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: true,
      parallelToolCalls: true,
      visionImages: true,
      thinking: false,
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

    // Phase 1d — local-model context floor. Ollama silently truncates at its
    // default `num_ctx` (2–4k) and vLLM can be launched with a small
    // `--max-model-len`; agentic tool use needs a documented 16k floor. When a
    // local backend reports an effective window below the floor, fail LOUDLY at
    // init rather than letting the server silently drop the prompt mid-session.
    if (
      (this.structuredOutputDialect === 'ollama' || this.structuredOutputDialect === 'vllm') &&
      this.maxContextTokens < LOCAL_CONTEXT_FLOOR_TOKENS
    ) {
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

    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL,
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
        toolOrder: this.toolOrder,
      },
    );

    if (this.toolCallFormat === 'text-xml') {
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

      yield* streamTextToolCalls(
        streamChatCompletions(this.client, paramsNoTools, options.abortSignal),
      );
    } else {
      yield* streamChatCompletions(this.client, params, options.abortSignal);
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
  if (typeof cfg.maxContextTokens !== 'number') {
    const dialect = detectStructuredOutputDialect(providerName, baseUrl);
    if (dialect === 'ollama' || dialect === 'vllm') {
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
