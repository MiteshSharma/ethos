import { estimateCost } from '@ethosagent/pricing';
import type {
  CompletionChunk,
  CompletionOptions,
  Message,
  TokenUsage,
  ToolDefinitionLite,
} from '@ethosagent/types';

export interface GeminiTransportConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export async function* streamGeminiGenerate(
  config: GeminiTransportConfig,
  messages: Message[],
  tools: ToolDefinitionLite[],
  options: CompletionOptions,
  signal?: AbortSignal,
): AsyncGenerator<CompletionChunk> {
  const base = config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  const url = `${base}/models/${config.model}:streamGenerateContent?alt=sse&key=${config.apiKey}`;

  const body = buildGeminiBody(messages, tools, options);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Gemini API error ${response.status}: ${errorText}`);
  }

  if (!response.body) throw new Error('Gemini response has no body');

  yield* parseGeminiSSE(response.body, config.model);
}

function buildGeminiBody(
  messages: Message[],
  tools: ToolDefinitionLite[],
  options: CompletionOptions,
): Record<string, unknown> {
  const contents = messages
    .filter((m) => m.role !== 'user' || typeof m.content === 'string' || m.content.length > 0)
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: typeof m.content === 'string' ? [{ text: m.content }] : m.content.map(convertPart),
    }));

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      ...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.topP !== undefined ? { topP: options.topP } : {}),
      ...(options.stopSequences?.length ? { stopSequences: options.stopSequences } : {}),
    },
  };

  if (options.system) {
    body.systemInstruction = { parts: [{ text: options.system }] };
  }

  if (tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }

  return body;
}

function convertPart(c: { type: string; [key: string]: unknown }): Record<string, unknown> {
  switch (c.type) {
    case 'text':
      return { text: c.text };
    case 'tool_use':
      return { functionCall: { name: c.name, args: c.input } };
    case 'tool_result':
      return { functionResponse: { name: c.tool_use_id, response: { result: c.content } } };
    case 'image':
      return { inlineData: { mimeType: c.mediaType, data: c.data } };
    default:
      return { text: String(c.text ?? '') };
  }
}

async function* parseGeminiSSE(
  body: ReadableStream<Uint8Array>,
  model: string,
): AsyncGenerator<CompletionChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let toolCallCounter = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        const dataLine = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed;
        if (!dataLine) continue;

        try {
          const event = JSON.parse(dataLine);
          yield* handleGeminiEvent(event, toolCallCounter, model);
          const candidates = event.candidates as Array<Record<string, unknown>> | undefined;
          if (candidates?.[0]) {
            const content = candidates[0].content as Record<string, unknown> | undefined;
            const eventParts = content?.parts as Array<Record<string, unknown>> | undefined;
            if (eventParts) {
              for (const p of eventParts) {
                if (p.functionCall) toolCallCounter++;
              }
            }
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Map Gemini's `usageMetadata` onto `TokenUsage`, priced.
 *
 * `promptTokenCount` INCLUDES `cachedContentTokenCount`, so the cached slice is
 * subtracted before the input rate is applied — otherwise a cache hit is billed
 * twice, once at the input rate and once at the cache-read rate. The reported
 * token counts keep Gemini's own meaning; only the cost math splits them.
 */
function geminiUsage(meta: Record<string, number>, model: string): TokenUsage {
  const promptTokens = meta.promptTokenCount ?? 0;
  const outputTokens = meta.candidatesTokenCount ?? 0;
  const cacheReadTokens = meta.cachedContentTokenCount ?? 0;
  return {
    inputTokens: promptTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens: 0,
    // Previously hardcoded to 0, which reported every Gemini turn as free.
    estimatedCostUsd: estimateCost(model, {
      inputTokens: Math.max(promptTokens - cacheReadTokens, 0),
      outputTokens,
      cacheReadTokens,
    }).costUsd,
  };
}

function* handleGeminiEvent(
  event: Record<string, unknown>,
  toolCallOffset: number,
  model: string,
): Generator<CompletionChunk> {
  const candidates = event.candidates as Array<Record<string, unknown>> | undefined;
  if (!candidates?.length) {
    const meta = event.usageMetadata as Record<string, number> | undefined;
    if (meta) {
      yield { type: 'usage', usage: geminiUsage(meta, model) };
    }
    return;
  }

  const candidate = candidates[0];
  const content = candidate.content as Record<string, unknown> | undefined;
  const parts = content?.parts as Array<Record<string, unknown>> | undefined;

  if (parts) {
    for (const part of parts) {
      if (part.text !== undefined) {
        yield { type: 'text_delta', text: part.text as string };
      } else if (part.functionCall) {
        const fc = part.functionCall as Record<string, unknown>;
        const toolCallId = `gemini-tc-${toolCallOffset}`;
        yield { type: 'tool_use_start', toolCallId, toolName: fc.name as string };
        const argsJson = JSON.stringify(fc.args ?? {});
        yield { type: 'tool_use_delta', toolCallId, partialJson: argsJson };
        yield { type: 'tool_use_end', toolCallId, inputJson: argsJson };
      }
    }
  }

  const finishReason = candidate.finishReason as string | undefined;
  if (finishReason) {
    const reason =
      finishReason === 'STOP'
        ? 'end_turn'
        : finishReason === 'MAX_TOKENS'
          ? 'max_tokens'
          : finishReason === 'SAFETY'
            ? 'end_turn'
            : 'end_turn';
    yield { type: 'done', finishReason: reason };
  }

  const meta = event.usageMetadata as Record<string, number> | undefined;
  if (meta) {
    yield { type: 'usage', usage: geminiUsage(meta, model) };
  }
}
