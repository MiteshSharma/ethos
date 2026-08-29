// tiered_summary — three-tier compaction: preserve front, summarize + page
// the middle, keep the recent tail. Combines LLM summarization with external
// store paging so a compressed summary stays in-window while the full middle
// is recoverable from storage. Degrades gracefully when either handle is
// missing.

import type {
  ContextEngine,
  ContextEngineCompactInput,
  ContextEngineCompactOutput,
  ContextEngineExternalWrite,
  ContextEngineRemovedEntry,
  Message,
  MessageContent,
} from '@ethosagent/types';
import { stripVisionBlocksForSummary } from '../agent-loop/vision-aging';
import { partitionStandingInstructions } from './standing-instructions';
import { estimateMessagesTokens, estimateMessageTokens } from './token-estimator';

interface TieredSummaryOptions {
  preserve_first_n_turns?: number;
  recent_window?: number;
  page_key_prefix?: string;
}

export class TieredSummaryEngine implements ContextEngine {
  readonly name = 'tiered_summary';

  async compact(opts: ContextEngineCompactInput): Promise<ContextEngineCompactOutput> {
    const options = (opts.personality.context_engine_options ?? {}) as TieredSummaryOptions;
    const preserveFront = Math.max(0, options.preserve_first_n_turns ?? 1);
    const recentWindow = Math.max(0, options.recent_window ?? 6);
    const prefix = options.page_key_prefix ?? 'paged';
    const target = opts.targetTokens;

    const front = opts.messages.slice(0, preserveFront);
    const tailKeep = Math.min(recentWindow, Math.max(0, opts.messages.length - preserveFront));
    const middle = opts.messages.slice(preserveFront, opts.messages.length - tailKeep);
    const tail = opts.messages.slice(opts.messages.length - tailKeep);

    if (middle.length === 0) {
      return { messages: opts.messages, notes: 'nothing to summarize' };
    }

    const ct = opts.countTokens;
    const measure = ct
      ? (msgs: Message[]) => ct(msgs)
      : (msgs: Message[]) => Promise.resolve(estimateMessagesTokens(msgs));

    const totalNow =
      estimateMessagesTokens(opts.currentSystem) + (await measure([...front, ...middle, ...tail]));
    if (totalNow <= target) {
      return { messages: opts.messages, notes: 'no compaction needed' };
    }

    // §3.4.1 — standing-instruction carry-forward: durable user directives in
    // the middle are excluded from the summarized content and carried verbatim
    // ahead of the summary. The FULL middle (directives included) is still
    // paged to the store below, so the raw range stays recoverable.
    const { carried, carriedIndices, rest } = partitionStandingInstructions(middle);
    if (rest.length === 0) {
      return {
        messages: [...front, ...carried, ...tail],
        notes: `carried ${carried.length} standing instruction(s); nothing to summarize`,
      };
    }

    // --- Summarize middle ---
    const summaryTarget = Math.max(200, Math.floor(target * 0.15));
    let summaryText: string;
    if (opts.llm) {
      // C3 — prose in, prose out: the summarizer never needs the image bytes.
      summaryText = await opts.llm.summarize(stripVisionBlocksForSummary(rest), summaryTarget);
    } else {
      summaryText = `[summary] ${rest.length} earlier message(s) elided to fit context budget.`;
    }

    // --- Page middle to store ---
    const externalWrites: ContextEngineExternalWrite[] = [];
    if (opts.store) {
      const key = `${prefix}-${opts.sessionMetadata.turnNumber}`;
      const serialized = JSON.stringify(middle);
      await opts.store.write(key, serialized);
      externalWrites.push({ key, tokenCount: estimateMessagesTokens(middle) });
    }

    // --- Build removed entries ---
    const reason: ContextEngineRemovedEntry['reason'] = opts.llm
      ? 'summarized'
      : opts.store
        ? 'paged_out'
        : 'trimmed';
    // Carried standing instructions stay in the output — no removed entry.
    const removed: ContextEngineRemovedEntry[] = [];
    for (let i = 0; i < middle.length; i++) {
      if (carriedIndices.has(i)) continue;
      removed.push({ index: preserveFront + i, reason });
    }

    const summaryMessage: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: summaryText } satisfies MessageContent],
    };

    // Cache breakpoints: end of front, the summary message.
    const cacheBreakpoints: number[] = [];
    if (front.length > 0) cacheBreakpoints.push(front.length - 1);
    cacheBreakpoints.push(front.length + carried.length);

    const carriedNote =
      carried.length > 0 ? `; carried ${carried.length} standing instruction(s)` : '';
    return {
      messages: [...front, ...carried, summaryMessage, ...tail],
      notes: `summarized ${rest.length} message(s) → ${estimateMessageTokens(summaryMessage)} tokens${carriedNote}`,
      summaryText,
      cacheBreakpoints,
      removed,
      summaries: [
        { text: summaryText, sourceRange: [preserveFront, preserveFront + middle.length] },
      ],
      externalWrites: externalWrites.length > 0 ? externalWrites : undefined,
      cacheAnchor: front.length + carried.length,
    };
  }

  shouldCompact(input: ContextEngineCompactInput): boolean {
    const total =
      estimateMessagesTokens(input.currentSystem) + estimateMessagesTokens(input.messages);
    return total > input.targetTokens * 0.75;
  }
}
