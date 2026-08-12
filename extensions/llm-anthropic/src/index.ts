import Anthropic from '@anthropic-ai/sdk';
import type {
  AuthProfile,
  CompletionChunk,
  CompletionOptions,
  FailoverReason,
  LLMProvider,
  Message,
  MessageContent,
  ProviderCapabilities,
  ToolDefinitionLite,
  ToolOrder,
} from '@ethosagent/types';
import { orderToolDefinitions } from '@ethosagent/types';
import { reduceToolSchemas } from './tool-schema';
import { type AnthropicStreamParams, streamAnthropicMessages } from './transport';

export { attributeToolSchemaBytes, reduceToolSchemas } from './tool-schema';
export { streamAnthropicMessages } from './transport';
export type { AnthropicStreamParams };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AnthropicProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Lane 2a — tool-definition ordering at the serialization boundary.
   *  Default `'stable'` (deterministic ASCII sort). `'insertion'` is a
   *  temporary rollback lever; removal tracked in plan/uncompleted-tasks.md. */
  toolOrder?: ToolOrder;
  /** Test seam — custom fetch handed to the Anthropic SDK client. Used by the
   *  golden request-body harness to capture exact wire bytes. Absent → the
   *  SDK's default fetch. */
  fetchImpl?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function modelContextTokens(_model: string): number {
  return 200_000; // all current Claude models
}

function isThinkingModel(model: string): boolean {
  return (
    model.includes('claude-3-7') ||
    model.includes('claude-opus-4') ||
    model.includes('claude-sonnet-4')
  );
}

function classifyError(err: unknown): FailoverReason {
  if (err instanceof Anthropic.AuthenticationError) return 'auth';
  if (err instanceof Anthropic.RateLimitError) return 'rate_limit';
  // APIStatusError covers 5xx and other HTTP errors
  if (err instanceof Anthropic.APIError) {
    const status = (err as { status?: number }).status;
    if (status === 529) return 'overloaded';
    if (status === 401 || status === 403) return 'auth';
    if (status === 429) return 'rate_limit';
  }
  return 'unknown';
}

// Convert our Message[] into Anthropic's MessageParam[]
export function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  return messages.map((msg) => {
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content };
    }
    const blocks = msg.content.map(toAnthropicBlock);
    return { role: msg.role, content: blocks };
  });
}

function toAnthropicBlock(block: MessageContent): Anthropic.ContentBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
        is_error: block.is_error,
      };
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: block.mediaType, data: block.data },
      };
    case 'document':
      // Anthropic PDF support (Base64PDFSource)
      return {
        type: 'document',
        source: { type: 'base64', media_type: block.mediaType, data: block.data },
      };
    default: {
      // Exhaustiveness guard — adding a new MessageContent variant without
      // teaching this mapper about it is a compile error, not silent fall-
      // through. The `never` cast surfaces the gap at the source.
      const _exhaustive: never = block;
      throw new Error(`unhandled MessageContent type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// context_compression F2 — place `cache_control` markers on message-history
// breakpoints. Anthropic allows at most 4 markers total (system + messages);
// `maxAllowed` is what remains after the system prompt. Indices are clamped to
// the message list and de-duplicated. When there are more breakpoints than
// slots, the *shallowest* ones are dropped: caching pays off on the largest
// stable prefix, so the deepest boundaries are the ones worth keeping. The
// marker lands on the last content block of the message so the cached prefix
// ends exactly at that message boundary.
export function applyMessageCacheBreakpoints(
  messages: Anthropic.MessageParam[],
  breakpoints: number[],
  maxAllowed: number,
): void {
  if (maxAllowed <= 0) return;
  const sorted = [...new Set(breakpoints)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < messages.length)
    .sort((a, b) => a - b);
  // Keep the deepest `maxAllowed` boundaries, still applied in ascending order.
  const valid = sorted.slice(Math.max(0, sorted.length - maxAllowed));
  for (const idx of valid) {
    const msg = messages[idx];
    if (!msg) continue;
    if (typeof msg.content === 'string') {
      msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
      continue;
    }
    const last = msg.content[msg.content.length - 1];
    // Every block our `toAnthropicBlock` emits (text / tool_use / tool_result)
    // carries `cache_control`, but the SDK's `ContentBlockParam` union also
    // includes thinking blocks that do not — narrow via a structural cast.
    if (last) {
      (last as { cache_control?: Anthropic.CacheControlEphemeral }).cache_control = {
        type: 'ephemeral',
      };
    }
  }
}

// ---------------------------------------------------------------------------
// AnthropicProvider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly model: string;
  readonly maxContextTokens: number;
  readonly supportsCaching = true;
  readonly supportsThinking: boolean;
  readonly supportsVision = { images: true, documents: true };
  readonly supportsCacheBreakpoints = true;
  readonly supportsTokenCounting: 'real' | 'estimated' = 'real';

  get capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: true,
      parallelToolCalls: true,
      visionImages: true,
      visionDocuments: true,
      thinking: this.supportsThinking,
      promptCaching: true,
      cacheBreakpoints: true,
      systemPromptStyle: 'top-level',
      tokenCounting: 'real',
      contractVersion: 1,
    };
  }

  private readonly client: Anthropic;
  private readonly toolOrder: ToolOrder;

  constructor(config: AnthropicProviderConfig) {
    this.model = config.model;
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      ...(config.fetchImpl ? { fetch: config.fetchImpl } : {}),
    });
    this.maxContextTokens = modelContextTokens(config.model);
    this.supportsThinking = isThinkingModel(config.model);
    this.toolOrder = config.toolOrder ?? 'stable';
  }

  async *complete(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk> {
    const anthropicMessages = toAnthropicMessages(messages);

    const systemBlocks: Anthropic.TextBlockParam[] | undefined = options.system
      ? [
          {
            type: 'text',
            text: options.system,
            ...(options.cacheSystemPrompt ? { cache_control: { type: 'ephemeral' } } : {}),
          },
        ]
      : undefined;

    // F2 — message-history cache breakpoints. The system prompt, when cached,
    // consumes one of Anthropic's 4 `cache_control` slots; the rest are
    // available for message-level breakpoints.
    if (options.cacheBreakpoints && options.cacheBreakpoints.length > 0) {
      const systemCached = systemBlocks !== undefined && options.cacheSystemPrompt === true;
      applyMessageCacheBreakpoints(
        anthropicMessages,
        options.cacheBreakpoints,
        4 - (systemCached ? 1 : 0),
      );
    }

    // Lane 2a — deterministic ASCII-stable tool ordering at the serialization
    // boundary. Tool definitions ship ahead of the messages and are part of
    // the cacheable prefix; registration order is not stable across restarts.
    // The ordering is a caching device, NOT a priority signal.
    const orderedTools = orderToolDefinitions(tools, this.toolOrder);

    // Phase 5 — trim the fixed tool-schema cost at the serialization boundary:
    // strip unused `$defs` and normalize description whitespace. Safe/lossless
    // by default; `requestTokens.tools` below then reflects the reduced size.
    const anthropicTools: Anthropic.Tool[] = reduceToolSchemas(orderedTools).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool['input_schema'],
    }));

    // Per-slice token computation (P1 observability) — best-effort, never blocks the call.
    let requestTokens: { system: number; tools: number; messages: number } | undefined;
    try {
      const systemText = options.system ?? '';
      const toolsText = anthropicTools.length > 0 ? JSON.stringify(anthropicTools) : '';
      const [sysTk, toolsTk, msgTk] = await Promise.all([
        systemText ? this.countTokens([{ role: 'user', content: systemText }]) : 0,
        toolsText ? this.countTokens([{ role: 'user', content: toolsText }]) : 0,
        this.countTokens(messages),
      ]);
      requestTokens = { system: sysTk, tools: toolsTk, messages: msgTk };
    } catch {
      // Best-effort: if token counting fails, requestTokens stays undefined.
    }

    const effectiveModel = options.modelOverride ?? this.model;

    const streamParams: AnthropicStreamParams = {
      model: effectiveModel,
      max_tokens: options.maxTokens ?? 8096,
      messages: anthropicMessages,
      ...(systemBlocks ? { system: systemBlocks } : {}),
      ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
      ...(options.stopSequences ? { stop_sequences: options.stopSequences } : {}),
      ...(options.topP !== undefined ? { top_p: options.topP } : {}),
      ...(isThinkingModel(effectiveModel) && options.thinkingBudget && options.thinkingBudget > 0
        ? { thinking: { type: 'enabled' as const, budget_tokens: options.thinkingBudget } }
        : {}),
      requestTokens,
    };

    yield* streamAnthropicMessages(this.client, streamParams, options.abortSignal);
  }

  async countTokens(messages: Message[]): Promise<number> {
    const result = await this.client.messages.countTokens({
      model: this.model,
      messages: toAnthropicMessages(messages),
    });
    return result.input_tokens;
  }
}

// ---------------------------------------------------------------------------
// AuthRotatingProvider — rotates API keys on auth/rate-limit failures
// ---------------------------------------------------------------------------

export class AuthRotatingProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly supportsCaching = true;

  private readonly providers: AnthropicProvider[];
  private current = 0;

  constructor(profiles: AuthProfile[], model: string, opts?: { toolOrder?: ToolOrder }) {
    const sorted = [...profiles].sort((a, b) => b.priority - a.priority);
    this.providers = sorted.map(
      (p) =>
        new AnthropicProvider({
          apiKey: p.apiKey,
          model,
          baseUrl: p.baseUrl,
          ...(opts?.toolOrder ? { toolOrder: opts.toolOrder } : {}),
        }),
    );
    if (this.providers.length === 0) throw new Error('AuthRotatingProvider: no profiles provided');
  }

  get model(): string {
    return this.providers[this.current]?.model ?? '';
  }

  get maxContextTokens(): number {
    return this.providers[this.current]?.maxContextTokens ?? 200_000;
  }

  get supportsThinking(): boolean {
    return this.providers[this.current]?.supportsThinking ?? false;
  }

  async *complete(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk> {
    const startIdx = this.current;

    for (let attempt = 0; attempt < this.providers.length; attempt++) {
      const provider = this.providers[this.current];
      let yieldedAny = false;
      try {
        if (!provider) throw new Error('AuthRotatingProvider: missing provider slot');
        for await (const chunk of provider.complete(messages, tools, options)) {
          yieldedAny = true;
          yield chunk;
        }
        return;
      } catch (err) {
        // Once the consumer has seen any chunk, failing over to a different
        // provider would emit a fresh stream from the start and corrupt the
        // assistant turn. Propagate the error instead.
        if (yieldedAny) throw err;

        const reason = classifyError(err);
        if (reason === 'auth' || reason === 'rate_limit' || reason === 'overloaded') {
          const next = (this.current + 1) % this.providers.length;
          if (next === startIdx) throw err; // full rotation exhausted
          this.current = next;
          continue;
        }
        throw err;
      }
    }
  }

  async countTokens(messages: Message[]): Promise<number> {
    return this.providers[this.current]?.countTokens(messages) ?? Promise.resolve(0);
  }
}

// ---------------------------------------------------------------------------
// First-party plugin activation (§9.2 — dogfooding the plugin SDK)
// ---------------------------------------------------------------------------

import type { EthosPluginApi, LLMProviderFactory } from '@ethosagent/plugin-sdk';

export const PROVIDER_CONTRACT_MAJOR = 3;

export const anthropicFactory: LLMProviderFactory = async ({ config: cfg, secrets, logger }) => {
  const secretKey = await secrets.get('providers/anthropic/apiKey');
  const apiKey = secretKey ?? (cfg.apiKey as string);
  if (secretKey === null && cfg.apiKey) {
    logger.warn(
      'Using plaintext apiKey from config for anthropic; migrate to the secret store: ethos secrets set providers/anthropic/apiKey <key>',
    );
  }
  return new AnthropicProvider({
    apiKey,
    model: cfg.model as string,
    // Lane 2a — tool-ordering escape hatch threaded from config; invalid
    // values fall through to the 'stable' default.
    ...(cfg.toolOrder === 'insertion' || cfg.toolOrder === 'stable'
      ? { toolOrder: cfg.toolOrder }
      : {}),
  });
};

export function activate(api: EthosPluginApi): void {
  api.registerLLMProvider('anthropic', anthropicFactory);
}
