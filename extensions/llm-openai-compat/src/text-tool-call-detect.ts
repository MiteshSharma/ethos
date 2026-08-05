// Lane 4b(f) — text-tool-call fallback detection.
//
// The dominant local failure mode: the model writes its tool call into
// `content` — `<tool_call>{json}</tool_call>` or a bare JSON object — and the
// turn ends `finish_reason: 'stop'` with zero native tool calls. This
// transform watches for exactly that shape, converts a STRICT structural
// match into tool-call chunks so the loop can dispatch it, and reports the
// detection so the provider can latch the model to the text-xml transport
// once the dispatch is confirmed (eng review D11/D18 — see index.ts).
//
// Strictness is the point (D11 negatives must not convert):
//   - The ENTIRE turn text (trimmed) must be the tool-call block — prose that
//     merely mentions a tool-call shape never matches the anchored parse.
//   - Exactly the keys `name` (string) + `arguments` (object), nothing else.
//   - `name` must be a KNOWN tool; an unknown name is left as text.
//   - Malformed/unbalanced blocks fail the parse and stream through as text.

import type { CompletionChunk } from '@ethosagent/types';

const OPEN_TAG = '<tool_call>';
const CLOSE_TAG = '</tool_call>';

export interface ParsedTextToolCall {
  name: string;
  argumentsJson: string;
}

/**
 * Anchored structural parse of a complete turn's text. Returns null unless
 * the trimmed text is exactly one `<tool_call>{json}</tool_call>` block or
 * one bare JSON object, with exactly `name` + `arguments` keys and a `name`
 * naming a known tool.
 */
export function parseStructuralToolCall(
  text: string,
  knownToolNames: ReadonlySet<string>,
): ParsedTextToolCall | null {
  const trimmed = text.trim();
  let jsonText: string;
  if (trimmed.startsWith(OPEN_TAG) && trimmed.endsWith(CLOSE_TAG)) {
    jsonText = trimmed.slice(OPEN_TAG.length, trimmed.length - CLOSE_TAG.length).trim();
    // A second tag inside the block means nesting or multiple calls — not the
    // strict single-block shape.
    if (jsonText.includes(OPEN_TAG) || jsonText.includes(CLOSE_TAG)) return null;
  } else if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    jsonText = trimmed;
  } else {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 2 || !('name' in obj) || !('arguments' in obj)) return null;
  const name = obj.name;
  const args = obj.arguments;
  if (typeof name !== 'string' || !knownToolNames.has(name)) return null;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null;
  return { name, argumentsJson: JSON.stringify(args) };
}

/** Could this leading turn text still turn out to be a pure tool-call turn? */
function couldBeToolCall(text: string): boolean {
  const t = text.trimStart();
  if (t.length === 0) return true;
  if (t.startsWith('{')) return true;
  return t.length < OPEN_TAG.length ? OPEN_TAG.startsWith(t) : t.startsWith(OPEN_TAG);
}

export interface TextToolCallDetection {
  toolCallId: string;
  toolName: string;
  /** The verbatim turn text that parsed as a tool call (for the latch log). */
  triggerText: string;
}

export interface TextToolCallDetectorHooks {
  nextToolCallId: () => string;
  onDetect: (detection: TextToolCallDetection) => void;
}

/**
 * Watch a structured-transport stream for a stop-turn whose entire text is a
 * strict tool-call shape. Text is buffered only while the turn's leading
 * characters still look like a tool-call block; ordinary prose streams
 * through with no added latency. On a match the text is replaced by
 * tool-call chunks and `done` becomes `tool_use`; on anything else the
 * buffered text is flushed byte-identical.
 */
export async function* detectTextToolCalls(
  upstream: AsyncIterable<CompletionChunk>,
  knownToolNames: ReadonlySet<string>,
  hooks: TextToolCallDetectorHooks,
): AsyncIterable<CompletionChunk> {
  let text = '';
  let candidate = true;
  let sawNativeToolCall = false;

  function* flushText(): Generator<CompletionChunk> {
    if (text.length > 0) {
      yield { type: 'text_delta', text };
      text = '';
    }
  }

  for await (const chunk of upstream) {
    if (chunk.type === 'text_delta') {
      if (!candidate) {
        yield chunk;
        continue;
      }
      text += chunk.text;
      if (!couldBeToolCall(text)) {
        candidate = false;
        yield* flushText();
      }
      continue;
    }

    if (
      chunk.type === 'tool_use_start' ||
      chunk.type === 'tool_use_delta' ||
      chunk.type === 'tool_use_end'
    ) {
      // Native tool calling works — the fallback must stay out of the way.
      sawNativeToolCall = true;
      candidate = false;
      yield* flushText();
      yield chunk;
      continue;
    }

    if (chunk.type === 'done') {
      if (candidate && !sawNativeToolCall && chunk.finishReason === 'end_turn') {
        const parsed = parseStructuralToolCall(text, knownToolNames);
        if (parsed) {
          const toolCallId = hooks.nextToolCallId();
          yield { type: 'tool_use_start', toolCallId, toolName: parsed.name };
          yield { type: 'tool_use_delta', toolCallId, partialJson: parsed.argumentsJson };
          yield { type: 'tool_use_end', toolCallId, inputJson: parsed.argumentsJson };
          hooks.onDetect({ toolCallId, toolName: parsed.name, triggerText: text });
          text = '';
          yield { type: 'done', finishReason: 'tool_use' };
          continue;
        }
      }
      yield* flushText();
      yield chunk;
      continue;
    }

    yield chunk;
  }

  // Upstream ended without done (the 4a guard throws before this in practice).
  yield* flushText();
}
