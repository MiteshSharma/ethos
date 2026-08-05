import type {
  CompletionChunk,
  CompletionOptions,
  Message,
  ToolDefinitionLite,
  ToolOrder,
} from '@ethosagent/types';
import { orderToolDefinitions } from '@ethosagent/types';
import type OpenAI from 'openai';
import { estimateCostOpenAI, normalizeGeminiSchema, toOpenAIMessages } from './index';
import { sanitizeToolSchemaForGrammar } from './schema-sanitize';

// ---------------------------------------------------------------------------
// Shared Chat Completions streaming transport
// ---------------------------------------------------------------------------

export interface ChatCompletionsStreamParams {
  oaiParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming;
  requestTokens?: { system: number; tools: number; messages: number };
  effectiveModel: string;
}

type StructuredOutputDialect = 'openai' | 'ollama' | 'vllm';

/**
 * §3 — forward a grammar-constrained JSON request built by
 * `structuredOutputOption` (@ethosagent/types). The caller sets
 * `providerOptions['openai-compat'].responseFormat = { name?, strict?, schema }`;
 * we map it to the provider dialect on the request body. Absent or malformed
 * (no `schema` object) → no field is set, so every existing call is unchanged.
 * The incoming value is caller data, so it is structurally guarded here.
 */
function applyStructuredOutput(
  oaiParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming,
  options: CompletionOptions,
  dialect: StructuredOutputDialect,
): void {
  const responseFormat = options.providerOptions?.['openai-compat']?.responseFormat;
  if (!responseFormat || typeof responseFormat !== 'object') return;
  const wrapper = responseFormat as Record<string, unknown>;
  const schema = wrapper.schema;
  if (!schema || typeof schema !== 'object') return;
  const jsonSchema = schema as Record<string, unknown>;
  const name = typeof wrapper.name === 'string' ? wrapper.name : 'response';
  const strict = typeof wrapper.strict === 'boolean' ? wrapper.strict : true;

  if (dialect === 'ollama') {
    // Ollama structured output: top-level `format` accepts a JSON schema.
    Object.assign(oaiParams, { format: jsonSchema });
  } else if (dialect === 'vllm') {
    // vLLM guided decoding: `guided_json` accepts a JSON schema.
    Object.assign(oaiParams, { guided_json: jsonSchema });
  } else {
    // OpenAI-compat standard: response_format json_schema.
    oaiParams.response_format = {
      type: 'json_schema',
      json_schema: { name, strict, schema: jsonSchema },
    };
  }
}

/**
 * Pure function that converts Ethos messages + options into the OpenAI Chat
 * Completions streaming params object. No I/O — all side-effect-free.
 */
export function buildChatCompletionsParams(
  messages: Message[],
  tools: ToolDefinitionLite[],
  options: CompletionOptions,
  model: string,
  opts?: {
    gemini?: boolean;
    countTokens?: (msgs: Message[]) => Promise<number>;
    structuredOutputDialect?: StructuredOutputDialect;
    toolOrder?: ToolOrder;
    /** Lane 3(a) — llamacpp-class grammar sanitizing at this boundary (D7).
     *  Absent → schemas pass through untouched (hosted dialects, Anthropic). */
    toolSchemaProfile?: 'llamacpp';
    /** Lane 3(a) — receives one line per sanitizer transformation, naming the
     *  tool and the change. A drop is never silent. */
    onSchemaChange?: (message: string) => void;
  },
): ChatCompletionsStreamParams {
  const oaiMessages = toOpenAIMessages(messages, options.system);

  // Lane 2a — deterministic ASCII-stable tool ordering at the serialization
  // boundary. Tool definitions ship ahead of the messages and are part of the
  // cacheable prefix (vLLM --enable-prefix-caching, llama.cpp --cache-reuse
  // hash it); registration order is not stable across restarts. The ordering
  // is a caching device, NOT a priority signal.
  const orderedTools = orderToolDefinitions(tools, opts?.toolOrder ?? 'stable');

  const oaiTools: OpenAI.Chat.ChatCompletionTool[] = orderedTools.map((t) => {
    let parameters = t.parameters;
    if (opts?.gemini) {
      parameters = normalizeGeminiSchema(parameters);
    } else if (opts?.toolSchemaProfile === 'llamacpp') {
      // Lane 3(a) — sanitize for the GBNF grammar compiler. Gated on the
      // llamacpp-class local dialect only; every transformation is surfaced
      // via onSchemaChange (logged by the provider, never silent).
      const sanitized = sanitizeToolSchemaForGrammar(t.name, parameters);
      for (const change of sanitized.changes) opts?.onSchemaChange?.(change);
      parameters = sanitized.schema;
    }
    return {
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters,
      },
    };
  });

  const effectiveModel = options.modelOverride ?? model;
  const oaiParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
    model: effectiveModel,
    messages: oaiMessages,
    stream: true,
    stream_options: { include_usage: true },
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.topP !== undefined ? { top_p: options.topP } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.stopSequences ? { stop: options.stopSequences } : {}),
    ...(oaiTools.length > 0 ? { tools: oaiTools } : {}),
  };

  applyStructuredOutput(oaiParams, options, opts?.structuredOutputDialect ?? 'openai');

  return { oaiParams, requestTokens: undefined, effectiveModel };
}

/**
 * Async version of buildChatCompletionsParams that also performs per-slice
 * token computation when a countTokens callback is provided.
 */
export async function buildChatCompletionsParamsAsync(
  messages: Message[],
  tools: ToolDefinitionLite[],
  options: CompletionOptions,
  model: string,
  opts?: {
    gemini?: boolean;
    countTokens?: (msgs: Message[]) => Promise<number>;
    structuredOutputDialect?: StructuredOutputDialect;
    toolOrder?: ToolOrder;
    toolSchemaProfile?: 'llamacpp';
    onSchemaChange?: (message: string) => void;
  },
): Promise<ChatCompletionsStreamParams> {
  const result = buildChatCompletionsParams(messages, tools, options, model, opts);

  // Per-slice token computation (P1 observability) — best-effort, never blocks the call.
  if (opts?.countTokens) {
    try {
      const oaiTools = result.oaiParams.tools ?? [];
      const systemText = options.system ?? '';
      const toolsText = oaiTools.length > 0 ? JSON.stringify(oaiTools) : '';
      const [sysTk, toolsTk, msgTk] = await Promise.all([
        systemText ? opts.countTokens([{ role: 'user', content: systemText }]) : 0,
        toolsText ? opts.countTokens([{ role: 'user', content: toolsText }]) : 0,
        opts.countTokens(messages),
      ]);
      result.requestTokens = { system: sysTk, tools: toolsTk, messages: msgTk };
    } catch {
      // Best-effort: if token counting fails, requestTokens stays undefined.
    }
  }

  return result;
}

/**
 * Streams Chat Completions from any OpenAI-compatible client (OpenAI or
 * AzureOpenAI — both extend the same base). Yields canonical CompletionChunk
 * events that AgentLoop can consume directly.
 */
export async function* streamChatCompletions(
  client: OpenAI,
  params: ChatCompletionsStreamParams,
  signal?: AbortSignal,
): AsyncIterable<CompletionChunk> {
  const stream = await client.chat.completions.create(params.oaiParams, { signal });

  // Track streaming tool calls by index (OpenAI streams them as deltas)
  const pendingTools = new Map<number, { id: string; name: string; args: string }>();

  // Lane 4a(c) — empty/silent-completion guard state. Local runtimes (Ollama,
  // llama.cpp, LM Studio, …) can end the SSE stream with no `finish_reason` at
  // all — abort, OOM, or a malformed final chunk. Without a guard the generator
  // returns having yielded NOTHING, not even `done`, and the failure is silent.
  let sawFinishReason = false;
  let sawOutput = false;

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
            params.effectiveModel,
            chunk.usage.prompt_tokens,
            chunk.usage.completion_tokens,
          ),
          requestTokens: params.requestTokens,
        },
        metadata: {},
      };
      continue;
    }

    if (!choice) continue;

    const delta = choice.delta;

    if (delta.content) {
      sawOutput = true;
      yield { type: 'text_delta', text: delta.content };
    }

    // Stream tool call deltas
    for (const tc of delta.tool_calls ?? []) {
      sawOutput = true;
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
    if (
      choice.finish_reason === 'tool_calls' ||
      choice.finish_reason === 'stop' ||
      choice.finish_reason === 'length'
    ) {
      sawFinishReason = true;
      for (const [, tc] of pendingTools) {
        yield { type: 'tool_use_end', toolCallId: tc.id, inputJson: tc.args };
      }
      pendingTools.clear();

      let finishReason: 'tool_use' | 'end_turn' | 'max_tokens' = 'end_turn';
      if (choice.finish_reason === 'tool_calls') finishReason = 'tool_use';
      else if (choice.finish_reason === 'length') finishReason = 'max_tokens';

      yield { type: 'done', finishReason };
    }
  }

  // Lane 4a(c) — the stream ended without ever carrying a `finish_reason`.
  // Unconditional across every dialect (universal bugfix per plan §2):
  //   - Nothing was streamed at all → name the failure. CompletionChunk has no
  //     error variant; the provider contract is to THROW, and AgentLoop's
  //     stream step surfaces it as an `error` AgentEvent (code `llm_error`).
  //   - Content or tool calls WERE streamed → the output is real, only the
  //     terminal chunk was lost. End the turn cleanly so the text isn't thrown
  //     away: flush any pending tool calls and synthesize `done`.
  if (!sawFinishReason) {
    if (!sawOutput) {
      throw new Error(
        `model ${params.effectiveModel} returned no output — the stream ended without a ` +
          'finish_reason (the runtime may have aborted, hit OOM, or dropped the final chunk)',
      );
    }
    const hadPendingTools = pendingTools.size > 0;
    for (const [, tc] of pendingTools) {
      yield { type: 'tool_use_end', toolCallId: tc.id, inputJson: tc.args };
    }
    pendingTools.clear();
    yield { type: 'done', finishReason: hadPendingTools ? 'tool_use' : 'end_turn' };
  }
}
