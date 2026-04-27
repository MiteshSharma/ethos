import Anthropic from '@anthropic-ai/sdk';
import type {
  AuthProfile,
  CompletionChunk,
  CompletionOptions,
  FailoverReason,
  LLMProvider,
  Message,
  MessageContent,
  ToolDefinitionLite,
} from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AnthropicProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
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

// Pricing per million tokens (approximate — update as pricing changes)
const PRICING: Array<{
  prefix: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}> = [
  { prefix: 'claude-opus-4', input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { prefix: 'claude-sonnet-4', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { prefix: 'claude-haiku-4', input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1.0 },
  { prefix: 'claude-3-7-sonnet', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { prefix: 'claude-3-5-sonnet', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { prefix: 'claude-3-5-haiku', input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1.0 },
  { prefix: 'claude-3-opus', input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
];

function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
): number {
  const p = PRICING.find((r) => model.includes(r.prefix)) ?? {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  };
  const M = 1_000_000;
  return (
    (inputTokens * p.input +
      outputTokens * p.output +
      cacheReadTokens * p.cacheRead +
      cacheCreationTokens * p.cacheWrite) /
    M
  );
}

function toFinishReason(
  reason: string | null | undefined,
): 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' {
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens') return 'max_tokens';
  if (reason === 'stop_sequence') return 'stop_sequence';
  return 'end_turn';
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
  if (block.type === 'text') {
    return { type: 'text', text: block.text };
  }
  if (block.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input as Record<string, unknown>,
    };
  }
  // tool_result
  return {
    type: 'tool_result',
    tool_use_id: block.tool_use_id,
    content: block.content,
    is_error: block.is_error,
  };
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

  private readonly client: Anthropic;

  constructor(config: AnthropicProviderConfig) {
    this.model = config.model;
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
    this.maxContextTokens = modelContextTokens(config.model);
    this.supportsThinking = isThinkingModel(config.model);
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

    const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool['input_schema'],
    }));

    const effectiveModel = options.modelOverride ?? this.model;
    // biome-ignore lint/suspicious/noExplicitAny: extended thinking params not yet in SDK types
    const params: any = {
      model: effectiveModel,
      max_tokens: options.maxTokens ?? 8096,
      messages: anthropicMessages,
      ...(systemBlocks ? { system: systemBlocks } : {}),
      ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
      ...(options.stopSequences ? { stop_sequences: options.stopSequences } : {}),
    };

    if (isThinkingModel(effectiveModel) && options.thinkingBudget && options.thinkingBudget > 0) {
      params.thinking = { type: 'enabled', budget_tokens: options.thinkingBudget };
    }

    let inputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let currentToolId: string | null = null;
    let currentBlockType: string | null = null;

    const stream = this.client.messages.stream(params, { signal: options.abortSignal });

    try {
      for await (const event of stream) {
        switch (event.type) {
          case 'message_start': {
            // Cast to access optional cache token fields (added with prompt caching beta)
            const u = event.message.usage as Anthropic.Usage & {
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
            inputTokens = u.input_tokens;
            cacheReadTokens = u.cache_read_input_tokens ?? 0;
            cacheCreationTokens = u.cache_creation_input_tokens ?? 0;
            break;
          }

          case 'content_block_start': {
            const { content_block } = event;
            currentBlockType = content_block.type;
            if (content_block.type === 'tool_use') {
              currentToolId = content_block.id;
              yield {
                type: 'tool_use_start',
                toolCallId: content_block.id,
                toolName: content_block.name,
              };
            }
            break;
          }

          case 'content_block_delta': {
            const { delta } = event;
            if (delta.type === 'text_delta') {
              yield { type: 'text_delta', text: delta.text };
            } else if (delta.type === 'input_json_delta' && currentToolId) {
              yield {
                type: 'tool_use_delta',
                toolCallId: currentToolId,
                partialJson: delta.partial_json,
              };
            } else if ((delta as { type: string; thinking?: string }).type === 'thinking_delta') {
              const thinking = (delta as { type: string; thinking: string }).thinking;
              yield { type: 'thinking_delta', thinking };
            }
            break;
          }

          case 'content_block_stop':
            if (currentBlockType === 'tool_use' && currentToolId) {
              yield { type: 'tool_use_end', toolCallId: currentToolId, inputJson: '' };
              currentToolId = null;
            }
            currentBlockType = null;
            break;

          case 'message_delta': {
            const outputTokens = event.usage?.output_tokens ?? 0;
            yield {
              type: 'usage',
              usage: {
                inputTokens,
                outputTokens,
                cacheReadTokens,
                cacheCreationTokens,
                estimatedCostUsd: estimateCost(
                  effectiveModel,
                  inputTokens,
                  outputTokens,
                  cacheReadTokens,
                  cacheCreationTokens,
                ),
              },
            };
            if (event.delta.stop_reason) {
              yield { type: 'done', finishReason: toFinishReason(event.delta.stop_reason) };
            }
            break;
          }
        }
      }
    } finally {
      stream.abort();
    }
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

  constructor(profiles: AuthProfile[], model: string) {
    const sorted = [...profiles].sort((a, b) => b.priority - a.priority);
    this.providers = sorted.map(
      (p) => new AnthropicProvider({ apiKey: p.apiKey, model, baseUrl: p.baseUrl }),
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
