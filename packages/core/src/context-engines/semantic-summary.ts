// semantic_summary — preserves the first N turns + the most recent tail,
// summarizes the middle into a synthetic assistant message, and emits the
// result as the new history. The summarization itself can be performed by
// an injected callable (so production wires the agent's LLM but tests can
// stub deterministically).
//
// When no summarizer is wired, the engine degrades to a "drop middle"
// strategy that's still cheaper than the conservative drop-oldest engine
// for long sessions where the original task description matters.

import type {
  ContextEngine,
  ContextEngineCompactInput,
  ContextEngineCompactOutput,
  Message,
  MessageContent,
} from '@ethosagent/types';
import { stripVisionBlocksForSummary } from '../agent-loop/vision-aging';
import { partitionStandingInstructions } from './standing-instructions';
import { estimateMessagesTokens, estimateMessageTokens } from './token-estimator';

export type SummarizerFn = (
  middle: Message[],
  targetTokens: number,
  /** Phase 2 — `/compact <focus…>` guidance threaded into the summarizer prompt. */
  instructions?: string,
) => Promise<string>;

interface SemanticSummaryOptions {
  preserve_first_n_turns?: number;
  summary_target_tokens?: number;
}

export class SemanticSummaryEngine implements ContextEngine {
  readonly name = 'semantic_summary';
  private readonly summarize: SummarizerFn | undefined;

  constructor(opts: { summarize?: SummarizerFn } = {}) {
    if (opts.summarize) this.summarize = opts.summarize;
  }

  async compact(opts: ContextEngineCompactInput): Promise<ContextEngineCompactOutput> {
    const options = (opts.personality.context_engine_options ?? {}) as SemanticSummaryOptions;
    const preserveFront = Math.max(0, options.preserve_first_n_turns ?? 1);
    const summaryTarget = options.summary_target_tokens ?? 800;
    const target = opts.targetTokens;

    const front = opts.messages.slice(0, preserveFront);
    // Keep the last 6 messages as recent context — fresh turns matter most.
    const tailKeep = Math.min(6, Math.max(0, opts.messages.length - preserveFront));
    const middle = opts.messages.slice(preserveFront, opts.messages.length - tailKeep);
    const tail = opts.messages.slice(opts.messages.length - tailKeep);

    if (middle.length === 0) {
      return { messages: opts.messages, notes: 'nothing to summarize' };
    }

    const middleTokens = estimateMessagesTokens(middle);
    const totalNow =
      estimateMessagesTokens(opts.currentSystem) +
      estimateMessagesTokens([...front, ...tail]) +
      middleTokens;
    if (totalNow <= target) {
      return { messages: opts.messages, notes: 'no compaction needed' };
    }

    // §3.4.1 — standing-instruction carry-forward: durable user directives in
    // the middle are excluded from the summarized content and carried verbatim
    // ahead of the summary (a third preserved class beside front and tail).
    const { carried, rest } = partitionStandingInstructions(middle);
    if (rest.length === 0) {
      return {
        messages: [...front, ...carried, ...tail],
        notes: `carried ${carried.length} standing instruction(s); nothing to summarize`,
      };
    }

    let summaryText: string;
    const summarizer = opts.llm?.summarize ?? this.summarize;
    if (summarizer) {
      // C3 — the summarizer produces prose; handing it the image bytes doubles
      // the cost of compacting and can overflow the summarizer's own window.
      // It sees what was attached, not the pixels.
      summaryText = await summarizer(
        stripVisionBlocksForSummary(rest),
        summaryTarget,
        opts.instructions,
      );
    } else {
      // Fallback: synthesise a deterministic placeholder. Loses information
      // but preserves history shape so downstream replay still works.
      summaryText = `[summary] ${rest.length} earlier message(s) elided to fit context budget.`;
    }

    const summaryMessage: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: summaryText } satisfies MessageContent],
    };

    // F2 — cache breakpoints at stable boundaries: the end of the verbatim
    // preserved-front block (stable across turns) and the summary message
    // itself (stable until the next compaction).
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
    };
  }
}
