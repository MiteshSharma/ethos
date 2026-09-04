// @ethosagent/pricing — one cache-aware rate table and one estimator, shared by
// every provider extension. Leaf package: it depends on @ethosagent/types and
// on nothing else, so any layer may consume it.
//
// See ./table.ts for the rates and how they are matched.

import type { TokenUsage } from '@ethosagent/types';
import { findRate } from './table';

export { findRate, MODEL_PRICING, type ModelRate, type TierBreak } from './table';

/** Token counts a cost is derived from. Cache buckets default to 0. */
export type CostTokens = Pick<TokenUsage, 'inputTokens' | 'outputTokens'> &
  Partial<Pick<TokenUsage, 'cacheReadTokens' | 'cacheCreationTokens'>>;

/**
 * Why a cost is what it is. The two zeros are NOT the same fact:
 *
 * - `local`  — a model served by a local runtime (Ollama, vLLM, llama.cpp,
 *   LM Studio). $0 is the true, intentional answer: nobody is billing.
 * - `unknown` — a model with no row in the table. $0 is a placeholder standing
 *   in for a number we do not have, and it is reported so the gap is visible
 *   rather than silently folded into the spend total.
 */
export type PricingBasis = 'priced' | 'local' | 'unknown';

export interface CostEstimate {
  costUsd: number;
  basis: PricingBasis;
}

export interface EstimateCostOptions {
  /**
   * The call was served by a local runtime. Takes precedence over the table:
   * `deepseek-r1` pulled through Ollama costs nothing even though the hosted
   * model of the same name has a published rate.
   */
  localRuntime?: boolean;
}

const MILLION = 1_000_000;

/**
 * Price one LLM call. Each token bucket is multiplied by its own rate, because
 * providers bill cache reads and cache writes at rates that are not the input
 * rate — pricing cache tokens as input is how a cached-heavy workload ends up
 * reported at several times its real cost.
 *
 * An unpriced model yields 0 and reports `pricing.unknown_model` through the
 * registered reporter, at most once per model per process.
 */
export function estimateCost(
  model: string,
  tokens: CostTokens,
  options?: EstimateCostOptions,
): CostEstimate {
  if (options?.localRuntime) return { costUsd: 0, basis: 'local' };

  const rate = findRate(model);
  if (!rate) {
    reportUnknownModel(model);
    return { costUsd: 0, basis: 'unknown' };
  }

  const cacheReadTokens = tokens.cacheReadTokens ?? 0;
  const cacheCreationTokens = tokens.cacheCreationTokens ?? 0;

  // Whole-request reprice above a prompt-size threshold (xAI). The comparison is
  // driven by the PROMPT — input + cache reads + cache writes — and deliberately
  // not by `inputTokens` alone: the provider's cliff is on how much context the
  // request carries, and cached tokens are still in that context. Counting only
  // `inputTokens` would put a 900K-token turn back under the threshold the
  // moment prompt caching started working, which is precisely the long-context
  // turn the tier exists to price. Output is excluded — it is not the prompt.
  // The tier SELECTS a rate set for every bucket; it does not split tokens
  // across two rates, because the provider does not prorate the overage either.
  const promptTokens = tokens.inputTokens + cacheReadTokens + cacheCreationTokens;
  const applicable =
    rate.tierBreak && promptTokens > rate.tierBreak.abovePromptTokens ? rate.tierBreak : rate;

  const costUsd =
    (tokens.inputTokens * applicable.input +
      tokens.outputTokens * applicable.output +
      cacheReadTokens * applicable.cacheRead +
      cacheCreationTokens * applicable.cacheWrite) /
    MILLION;

  return { costUsd, basis: 'priced' };
}

// ---------------------------------------------------------------------------
// Unknown-model reporting
// ---------------------------------------------------------------------------
//
// The estimator is called from inside provider transports, which hold no
// observability handle and should not grow one — so the sink is registered once
// per process by the composition root (apps/ethos/src/wiring.ts) and the
// de-duplication lives here, next to the only code that can see every miss.
// One event per model per process: an unpriced model misses on EVERY call of
// every turn, and an event stream that repeats the same fact thousands of times
// is not a signal.

export type UnknownModelReporter = (model: string) => void;

let reporter: UnknownModelReporter | undefined;
const alreadyReported = new Set<string>();

/** Register (or with `undefined`, unregister) the process-wide sink. */
export function setUnknownModelReporter(fn: UnknownModelReporter | undefined): void {
  reporter = fn;
}

/** Test seam — forget which models have been reported in this process. */
export function resetUnknownModelReports(): void {
  alreadyReported.clear();
}

function reportUnknownModel(model: string): void {
  const sink = reporter;
  // No sink yet (early startup, library consumers, tests): stay unmarked so the
  // first miss after registration is still reported.
  if (!sink) return;
  if (alreadyReported.has(model)) return;
  // Mark before calling: a throwing sink must not turn into a retry on every
  // subsequent call, and observability never breaks a turn.
  alreadyReported.add(model);
  try {
    sink(model);
  } catch {
    // Fail-open, per the observability posture everywhere else in the tree.
  }
}
