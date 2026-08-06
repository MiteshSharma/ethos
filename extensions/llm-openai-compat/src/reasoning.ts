// Lane 4b(b) — reasoning/thinking passthrough for the OpenAI-compat transport.
//
// Reasoning models surface their chain-of-thought in two wire shapes:
//   1. `delta.reasoning_content` (DeepSeek-R1, Qwen3 via vLLM/Ollama) or
//      `delta.reasoning` (OpenRouter) — handled inside streamChatCompletions.
//   2. `<think>…</think>` blocks embedded in `delta.content` — handled here by
//      `parseThinkBlocks`, which emits the inner content as `thinking_delta`
//      and strips it from the text stream. ONLY well-formed balanced blocks
//      are converted; an unbalanced `<think>` (or a conversational mention)
//      is left in the text untouched (plan Lane 4 risk: "reasoning stripping
//      can eat real content").
//
// `withReasoningOnlyRetry` adds the reasoning-only-turn safety net: a stream
// that ends with thinking but zero text and zero tool calls gets ONE retry,
// NOT gated on any vendor name — the exact mistake OpenClaw #101077 documents
// (its retry was GPT-5-only, so every other reasoning model got zero retries).
//
// Both reuse the EXISTING `thinking_delta` CompletionChunk variant
// (packages/types/src/llm.ts) — no new chunk or AgentEvent variant.

import type { CompletionChunk } from '@ethosagent/types';

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/**
 * Convert well-formed `<think>…</think>` blocks in the text stream into
 * `thinking_delta` chunks, stripping them from `text_delta`. Text outside
 * blocks streams through (with a small hold-back window for a partial open
 * tag at a chunk boundary). An unbalanced block is flushed as literal text
 * before `done`, byte-identical to what the model wrote.
 */
export async function* parseThinkBlocks(
  upstream: AsyncIterable<CompletionChunk>,
): AsyncIterable<CompletionChunk> {
  let buffer = '';
  let insideThink = false;

  function* drain(): Generator<CompletionChunk> {
    while (buffer.length > 0) {
      if (!insideThink) {
        const openIdx = buffer.indexOf(THINK_OPEN);
        if (openIdx === -1) {
          // No open tag — emit all but a tail window that could be the start
          // of a split '<think>' arriving on the next delta.
          const safeLen = buffer.length - THINK_OPEN.length;
          if (safeLen > 0) {
            yield { type: 'text_delta', text: buffer.slice(0, safeLen) };
            buffer = buffer.slice(safeLen);
          }
          return;
        }
        if (openIdx > 0) {
          yield { type: 'text_delta', text: buffer.slice(0, openIdx) };
        }
        buffer = buffer.slice(openIdx + THINK_OPEN.length);
        insideThink = true;
      }

      const closeIdx = buffer.indexOf(THINK_CLOSE);
      if (closeIdx === -1) return; // block still open — wait for more data
      const inner = buffer.slice(0, closeIdx);
      if (inner.length > 0) yield { type: 'thinking_delta', thinking: inner };
      buffer = buffer.slice(closeIdx + THINK_CLOSE.length);
      insideThink = false;
    }
  }

  function* flush(): Generator<CompletionChunk> {
    if (insideThink) {
      // Unbalanced block — the model (or prose mentioning the tag) never
      // closed it. Restore the open tag and emit untouched as text.
      yield { type: 'text_delta', text: `${THINK_OPEN}${buffer}` };
    } else if (buffer.length > 0) {
      yield { type: 'text_delta', text: buffer };
    }
    buffer = '';
    insideThink = false;
  }

  for await (const chunk of upstream) {
    if (chunk.type === 'text_delta') {
      buffer += chunk.text;
      yield* drain();
      continue;
    }
    if (chunk.type === 'done') {
      yield* flush();
      yield chunk;
      continue;
    }
    yield chunk;
  }

  // Upstream ended without done (the 4a guard throws before this in practice).
  yield* flush();
}

/**
 * Reasoning-only-turn retry: when an attempt ends with thinking output but no
 * visible text and no tool calls, re-issue the request ONCE. Applies to every
 * provider name — never vendor-gated. The second attempt streams through
 * unconditionally, so at most one extra request is made per turn.
 */
export async function* withReasoningOnlyRetry(
  makeAttempt: () => AsyncIterable<CompletionChunk>,
  model: string,
  onDiagnostic?: (message: string) => void,
): AsyncIterable<CompletionChunk> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const isLastAttempt = attempt === 1;
    let sawThinking = false;
    let sawSubstance = false; // non-whitespace text or any tool call
    let reasoningOnly = false;

    for await (const chunk of makeAttempt()) {
      if (chunk.type === 'thinking_delta') sawThinking = true;
      else if (chunk.type === 'text_delta' && chunk.text.trim().length > 0) sawSubstance = true;
      else if (chunk.type === 'tool_use_start') sawSubstance = true;

      // Post-review FIX 3 — never retry a turn that ended `max_tokens`
      // (finish_reason 'length'): the output cap was exhausted mid-reasoning,
      // so a retry re-pays the full request on hosted reasoning models and
      // typically truncates again. Only a genuinely-complete reasoning-only
      // turn ('end_turn') is worth one more attempt.
      if (
        chunk.type === 'done' &&
        chunk.finishReason !== 'max_tokens' &&
        !isLastAttempt &&
        sawThinking &&
        !sawSubstance
      ) {
        // Suppress this done and retry; trailing chunks (usage) still pass.
        reasoningOnly = true;
        continue;
      }
      yield chunk;
    }

    if (!reasoningOnly) return;
    onDiagnostic?.(
      `reasoning-only turn (${model}): the stream ended with thinking but no text and no ` +
        'tool calls; retrying once (retry is not vendor-gated)',
    );
  }
}
