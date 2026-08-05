// Template: Custom Context Engine
//
// Copy this template into your workspace, rename the class, and implement
// your compaction strategy. Register the engine via your plugin's setup():
//
//   api.registerContextEngine(new MyEngine());
//
// Then select it in a personality config:
//
//   context_engine: my_engine_name

import type {
  ContextEngine,
  ContextEngineCompactInput,
  ContextEngineCompactOutput,
  ContextEngineExternalWrite,
  ContextEngineRemovedEntry,
  ContextEngineTurnCompleteInput,
  ContextEngineTurnCompleteOutput,
  Message,
  MessageContent,
} from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Cheap token estimator — same heuristic as the framework's token-estimator.ts.
// Use opts.countTokens() when available for model-accurate counts.
// ---------------------------------------------------------------------------
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessageTokens(msg: Message): number {
  if (typeof msg.content === 'string') return estimateTokens(msg.content);
  let chars = 0;
  for (const block of msg.content) {
    if (block.type === 'text') chars += block.text.length;
  }
  return Math.ceil(chars / 4);
}

function estimateAllTokens(messages: Message[], system: string): number {
  let total = estimateTokens(system);
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

// ---------------------------------------------------------------------------
// Standing instructions — durable user directives that must survive compaction.
// Same heuristic the framework uses (an explicit `[pin]` / `pin:` prefix, or a
// short message carrying a durable-scope marker); kept local so the template
// has no runtime dependency beyond @ethosagent/types.
// ---------------------------------------------------------------------------
const PIN_PREFIX = /^\s*(\[pin\]|pin:)/i;
const DURABLE_SCOPE = /\b(always|never|from now on|going forward|every time|do not ever)\b/i;
const MAX_DIRECTIVE_CHARS = 500;

function isStandingInstruction(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (PIN_PREFIX.test(trimmed)) return true;
  if (trimmed.length > MAX_DIRECTIVE_CHARS) return false;
  return DURABLE_SCOPE.test(trimmed);
}

/** Plain text of a message for directive detection (text blocks only). */
function directiveText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content;
  return msg.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** Every `tool_use` id in the history, oldest first — the id space
 *  `onTurnComplete` nominations must stay inside. */
function toolUseIds(messages: Message[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const block of m.content) {
      if (block.type === 'tool_use') ids.push(block.id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Engine implementation
// ---------------------------------------------------------------------------

export class CustomContextEngine implements ContextEngine {
  // Replace with your engine's unique name. This is the string authors put
  // in personality config: `context_engine: custom_engine`
  readonly name = 'custom_engine';

  // --- shouldCompact (optional) -------------------------------------------
  // NOT WIRED. The framework does NOT call this today — `maybeCompact` decides
  // purely on its own pressure gate, so declaring `shouldCompact` gets your
  // engine no extra trigger. It is declared, conformance-tested and reserved.
  // Implement it if you like (the shape is stable), but do not design
  // behaviour around it until a framework call site exists.
  shouldCompact(input: ContextEngineCompactInput): boolean {
    const current = estimateAllTokens(input.messages, input.currentSystem);
    // Trigger at 75% of target — leaves headroom for the next turn.
    return current > input.targetTokens * 0.75;
  }

  // --- onTurnComplete (optional) ------------------------------------------
  // WIRED. The framework calls this at the end of EVERY turn, before its
  // turn-end auto-compaction and memory-flush gates. It is the amortization
  // seam: nominate a small slice of stale tool results each turn instead of
  // waiting for one long compaction stall at the pressure gate.
  //
  // Four rules the framework relies on — break any of them and you invalidate
  // the prompt cache on every subsequent turn:
  //   1. Nominate `tool_use` IDS, never array indices. The array grows.
  //   2. Be deterministic. The same input must produce the same nominations,
  //      so a turn with no state change rewrites the view byte-identically.
  //   3. Only ever ADD. The framework unions nominations and never un-ages an
  //      id, but an engine that oscillates wastes the union.
  //   4. Never nominate an id that is not in `input.messages`.
  // Return `null` to leave the framework's own default schedule in charge.
  async onTurnComplete(
    input: ContextEngineTurnCompleteInput,
  ): Promise<ContextEngineTurnCompleteOutput | null> {
    // Below half the window there is nothing worth amortizing.
    if (input.pressureRatio < 0.5) return null;
    const ids = toolUseIds(input.messages);
    // Skip the newest two tool calls — the agent likely still needs them.
    const stale = ids.slice(0, Math.max(0, ids.length - 2));
    if (stale.length === 0) return null;
    return {
      trimToolResults: stale,
      notes: `nominated ${stale.length} stale tool result(s) for trimming`,
    };
  }

  // --- compact ------------------------------------------------------------
  // Called when the framework decides compaction is needed. Must return a
  // valid message history that fits (or is closer to fitting) the budget.
  async compact(opts: ContextEngineCompactInput): Promise<ContextEngineCompactOutput> {
    const { messages, currentSystem, targetTokens } = opts;

    // 1. Check whether compaction is actually needed.
    const currentTokens = estimateAllTokens(messages, currentSystem);
    if (currentTokens <= targetTokens) {
      return { messages, notes: 'no compaction needed' };
    }

    // 2. Split the history into three regions:
    //    - front: the first message (task description) — always preserved
    //    - middle: candidates for summarization / eviction
    //    - tail: the last 4 messages — recent context the LLM needs verbatim
    const front = messages.slice(0, 1);
    const tailSize = Math.min(4, Math.max(0, messages.length - 1));
    const middle = messages.slice(1, messages.length - tailSize);
    const tail = messages.slice(messages.length - tailSize);

    // Nothing in the middle to compact — return unchanged.
    if (middle.length === 0) {
      return { messages, notes: 'no compaction needed — no middle segment' };
    }

    // 3. Pull durable user directives ("always …", "never …", "from now on …")
    //    out of the middle and carry them forward VERBATIM. Summarizing a
    //    standing instruction away is a known compaction failure, and the
    //    conformance harness checks for it.
    const carriedIdx = new Set<number>();
    for (let i = 0; i < middle.length; i++) {
      const m = middle[i];
      if (m && m.role === 'user' && isStandingInstruction(directiveText(m))) carriedIdx.add(i);
    }
    const carried = middle.filter((_, i) => carriedIdx.has(i));
    const rest = middle.filter((_, i) => !carriedIdx.has(i));
    if (rest.length === 0) {
      return { messages, notes: 'no compaction needed — the middle is all standing instructions' };
    }

    // 4. Summarize what is left of the middle segment.
    //    Use the injected LLM handle when available; fall back to a placeholder.
    let summaryText: string;
    if (opts.llm) {
      const summaryTarget = Math.max(200, Math.floor(targetTokens * 0.15));
      summaryText = await opts.llm.summarize(rest, summaryTarget);
    } else {
      summaryText = `[summary] ${rest.length} earlier message(s) were removed to fit the context budget.`;
    }

    // 5. Page out the raw summarized slice to the external store when available.
    //    This preserves full fidelity for later retrieval if the engine or
    //    personality supports recall.
    const externalWrites: ContextEngineExternalWrite[] = [];
    if (opts.store) {
      const serialized = JSON.stringify(rest);
      const key = `compacted-${opts.sessionMetadata.sessionId}-${Date.now()}`;
      await opts.store.write(key, serialized);
      externalWrites.push({ key, tokenCount: estimateTokens(serialized) });
    }

    // 6. Build the synthetic summary message.
    const summaryContent: MessageContent = { type: 'text', text: summaryText };
    const summaryMessage: Message = {
      role: 'assistant',
      content: [summaryContent],
    };

    // 7. Assemble the compacted history.
    const compacted = [...front, ...carried, summaryMessage, ...tail];

    // 8. Build the audit trail — only the summarized slice was removed.
    const removed: ContextEngineRemovedEntry[] = [];
    for (let i = 0; i < middle.length; i++) {
      if (carriedIdx.has(i)) continue;
      removed.push({
        index: i + 1, // offset by front.length (1)
        reason: opts.store ? ('paged_out' as const) : ('summarized' as const),
      });
    }

    // 9. Cache breakpoints: end of preserved-front and the summary message.
    const cacheBreakpoints: number[] = [];
    if (front.length > 0) cacheBreakpoints.push(front.length - 1);
    cacheBreakpoints.push(front.length + carried.length); // the summary index

    return {
      messages: compacted,
      notes: `summarized ${rest.length} message(s) into 1, carried ${carried.length} verbatim`,
      summaryText,
      removed,
      summaries: [{ text: summaryText, sourceRange: [1, 1 + middle.length] }],
      externalWrites: externalWrites.length > 0 ? externalWrites : undefined,
      cacheBreakpoints,
    };
  }
}

// Default export for convenience; named export for explicit imports.
export default CustomContextEngine;
