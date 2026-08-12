import { estimateCost } from '@ethosagent/pricing';
import type {
  CompletionChunk,
  CompletionOptions,
  Message,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { type SigV4Config, SigV4Signer } from './sigv4';

export interface BedrockTransportConfig {
  region: string;
  sigv4: SigV4Config;
  modelId: string;
}

export async function* streamBedrockConverse(
  config: BedrockTransportConfig,
  messages: Message[],
  tools: ToolDefinitionLite[],
  options: CompletionOptions,
  signal?: AbortSignal,
): AsyncGenerator<CompletionChunk> {
  const signer = new SigV4Signer(config.sigv4);
  const endpoint = `https://bedrock-runtime.${config.region}.amazonaws.com`;
  const path = `/model/${encodeURIComponent(config.modelId)}/converse-stream`;
  const url = `${endpoint}${path}`;

  const body = buildConverseBody(messages, tools, options);
  const bodyStr = JSON.stringify(body);

  const signed = await signer.sign({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      accept: 'application/vnd.amazon.eventstream',
    },
    body: bodyStr,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: signed.headers,
    body: bodyStr,
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Bedrock API error ${response.status}: ${errorText}`);
  }

  if (!response.body) throw new Error('Bedrock response has no body');

  yield* parseBedrockEventStream(response.body, config.modelId);
}

function buildConverseBody(
  messages: Message[],
  tools: ToolDefinitionLite[],
  options: CompletionOptions,
): Record<string, unknown> {
  const converseMessages = messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? [{ text: m.content }] : m.content.map(convertContent),
  }));

  const body: Record<string, unknown> = {
    messages: converseMessages,
    ...(options.system ? { system: [{ text: options.system }] } : {}),
    inferenceConfig: {
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.topP !== undefined ? { topP: options.topP } : {}),
      ...(options.stopSequences?.length ? { stopSequences: options.stopSequences } : {}),
    },
  };

  if (tools.length > 0) {
    body.toolConfig = {
      tools: tools.map((t) => ({
        toolSpec: {
          name: t.name,
          description: t.description,
          inputSchema: { json: t.parameters },
        },
      })),
    };
  }

  return body;
}

function convertContent(c: { type: string; [key: string]: unknown }): Record<string, unknown> {
  switch (c.type) {
    case 'text':
      return { text: c.text };
    case 'tool_use':
      return { toolUse: { toolUseId: c.id, name: c.name, input: c.input } };
    case 'tool_result':
      return {
        toolResult: {
          toolUseId: c.tool_use_id,
          content: [{ text: c.content }],
          status: c.is_error ? 'error' : 'success',
        },
      };
    case 'image':
      return {
        image: { format: (c.mediaType as string).split('/')[1], source: { bytes: c.data } },
      };
    case 'document':
      return { document: { format: 'pdf', source: { bytes: c.data } } };
    default:
      return { text: String(c.text ?? '') };
  }
}

async function* parseBedrockEventStream(
  body: ReadableStream<Uint8Array>,
  modelId: string,
): AsyncGenerator<CompletionChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Bedrock event stream uses newline-delimited JSON events
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;

        try {
          const event = JSON.parse(trimmed);
          yield* handleBedrockEvent(event, modelId);
        } catch {
          // Skip non-JSON lines (event stream framing)
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function* handleBedrockEvent(
  event: Record<string, unknown>,
  modelId: string,
): Generator<CompletionChunk> {
  if (event.contentBlockStart) {
    const start = event.contentBlockStart as Record<string, unknown>;
    const block = start.start as Record<string, unknown> | undefined;
    if (block?.toolUse) {
      const tu = block.toolUse as Record<string, unknown>;
      yield {
        type: 'tool_use_start',
        toolCallId: tu.toolUseId as string,
        toolName: tu.name as string,
      };
    }
  } else if (event.contentBlockDelta) {
    const delta = event.contentBlockDelta as Record<string, unknown>;
    const d = delta.delta as Record<string, unknown>;
    if (d?.text !== undefined) {
      yield { type: 'text_delta', text: d.text as string };
    } else if (d?.toolUse) {
      const tu = d.toolUse as Record<string, unknown>;
      yield { type: 'tool_use_delta', toolCallId: '', partialJson: tu.input as string };
    }
  } else if (event.messageStop) {
    const stop = event.messageStop as Record<string, unknown>;
    const reason = stop.stopReason as string;
    const finishReason =
      reason === 'tool_use' ? 'tool_use' : reason === 'max_tokens' ? 'max_tokens' : 'end_turn';
    yield { type: 'done', finishReason };
  } else if (event.metadata) {
    const meta = event.metadata as Record<string, unknown>;
    const usage = meta.usage as Record<string, number> | undefined;
    if (usage) {
      const inputTokens = usage.inputTokens ?? 0;
      const outputTokens = usage.outputTokens ?? 0;
      yield {
        type: 'usage',
        usage: {
          inputTokens,
          outputTokens,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          // Bedrock model ids carry the vendor model name
          // (`us.anthropic.claude-sonnet-4-...`), so the shared table resolves
          // them without Bedrock-specific rows. Previously hardcoded to 0,
          // which reported every Bedrock turn as free.
          estimatedCostUsd: estimateCost(modelId, { inputTokens, outputTokens }).costUsd,
        },
      };
    }
  }
}
