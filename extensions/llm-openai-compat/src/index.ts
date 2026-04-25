import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  ToolDefinitionLite,
} from '@ethosagent/types';
import OpenAI from 'openai';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OpenAICompatProviderConfig {
  name: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  maxContextTokens?: number;
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

function toOpenAIMessages(
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

      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          toolResults.push({ tool_call_id: block.tool_use_id, content: block.content });
        } else if (block.type === 'text') {
          textParts.push(block.text);
        }
      }

      // User text content
      if (textParts.length > 0) {
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

function estimateCostOpenAI(model: string, inputTokens: number, outputTokens: number): number {
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

  private readonly client: OpenAI;
  private readonly gemini: boolean;

  constructor(config: OpenAICompatProviderConfig) {
    this.name = config.name;
    this.model = config.model;
    this.maxContextTokens = config.maxContextTokens ?? 128_000;
    this.gemini = isGeminiEndpoint(config.baseUrl);
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
  }

  async *complete(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk> {
    const oaiMessages = toOpenAIMessages(messages, options.system);

    const oaiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: this.gemini ? normalizeGeminiSchema(t.parameters) : t.parameters,
      },
    }));

    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages: oaiMessages,
      stream: true,
      stream_options: { include_usage: true },
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.stopSequences ? { stop: options.stopSequences } : {}),
      ...(oaiTools.length > 0 ? { tools: oaiTools } : {}),
    };

    const stream = await this.client.chat.completions.create(params, {
      signal: options.abortSignal,
    });

    // Track streaming tool calls by index (OpenAI streams them as deltas)
    const pendingTools = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      const choice = chunk.choices[0];

      // Usage chunk (comes on its own chunk when stream_options.include_usage=true)
      if (!choice && chunk.usage) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            estimatedCostUsd: estimateCostOpenAI(
              this.model,
              chunk.usage.prompt_tokens,
              chunk.usage.completion_tokens,
            ),
          },
        };
        continue;
      }

      if (!choice) continue;

      const delta = choice.delta;

      if (delta.content) {
        yield { type: 'text_delta', text: delta.content };
      }

      // Stream tool call deltas
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index;

        if (!pendingTools.has(idx)) {
          // First delta for this tool call — has id and name
          const id = tc.id ?? '';
          const name = tc.function?.name ?? '';
          pendingTools.set(idx, { id, name, args: '' });
          yield { type: 'tool_use_start', toolCallId: id, toolName: name };
        }

        const pending = pendingTools.get(idx);
        if (pending && tc.function?.arguments) {
          pending.args += tc.function.arguments;
          yield {
            type: 'tool_use_delta',
            toolCallId: pending.id,
            partialJson: tc.function.arguments,
          };
        }
      }

      // Finish
      if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
        for (const [, tc] of pendingTools) {
          yield { type: 'tool_use_end', toolCallId: tc.id, inputJson: tc.args };
        }
        pendingTools.clear();
        yield {
          type: 'done',
          finishReason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
        };
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
