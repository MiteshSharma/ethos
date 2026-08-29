// The one LLM rate table. Rates are USD per 1,000,000 tokens.
//
// WHY ONE TABLE. Before this package there were two hardcoded tables
// (llm-anthropic, llm-openai-compat) and three hardcoded `estimatedCostUsd: 0`
// literals (llm-bedrock, llm-codex, llm-gemini). Three of the five providers
// therefore reported every turn as free, and llm-anthropic silently priced any
// unrecognised `claude-*` id at Sonnet rates — a wrong number is worse than a
// missing one, because a wrong number looks like an answer.
//
// CACHE AWARENESS. Providers do not bill cache-read and cache-creation tokens
// at the ordinary input rate, so each row carries all four rates and
// `estimateCost` multiplies each bucket separately. A row where a provider does
// not bill a distinct cache rate sets `cacheRead` equal to `input` (those
// tokens ARE ordinary input to that provider) and `cacheWrite` to 0 (no
// provider outside Anthropic bills for writing the cache).
//
// MATCHING. `prefix` is matched with a case-insensitive substring test against
// the model id, first row wins, so the table is ordered most-specific-first
// (`gpt-4o-mini` before `gpt-4o`). Substring matching is what lets one row
// serve the same model across routes: `claude-sonnet-4` matches Anthropic's
// `claude-sonnet-4-6`, Bedrock's `us.anthropic.claude-sonnet-4-20250514-v1:0`
// and OpenRouter's `anthropic/claude-sonnet-4-6` without three rows.
//
// PROVENANCE. Anthropic and the pre-existing OpenAI/Gemini/DeepSeek/Mistral
// input+output rates are carried over verbatim from the two tables this package
// replaces, so no priced model changes price in this commit. Cache-read rates
// and the newly-priced rows (gemini-2.5-*, deepseek-chat/reasoner) come from the
// providers' published list prices. A model with no row is NOT guessed at — see
// `estimateCost`, which returns 0 and reports it as unpriced.

export interface ModelRate {
  /** Case-insensitive substring matched against the model id. */
  prefix: string;
  /** USD per 1M ordinary input (prompt) tokens. */
  input: number;
  /** USD per 1M output (completion) tokens. */
  output: number;
  /** USD per 1M tokens served from the prompt cache. */
  cacheRead: number;
  /** USD per 1M tokens written into the prompt cache. */
  cacheWrite: number;
}

export const MODEL_PRICING: readonly ModelRate[] = [
  // ── Anthropic (also reached via Bedrock, Azure and OpenRouter ids) ────────
  { prefix: 'claude-opus-4', input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { prefix: 'claude-sonnet-4', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { prefix: 'claude-haiku-4', input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1.0 },
  { prefix: 'claude-3-7-sonnet', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { prefix: 'claude-3-5-sonnet', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { prefix: 'claude-3-5-haiku', input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1.0 },
  { prefix: 'claude-3-opus', input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },

  // ── OpenAI (cached input billed at half the input rate) ───────────────────
  { prefix: 'gpt-4o-mini', input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
  { prefix: 'gpt-4o', input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
  { prefix: 'gpt-4-turbo', input: 10, output: 30, cacheRead: 10, cacheWrite: 0 },
  { prefix: 'gpt-4', input: 30, output: 60, cacheRead: 30, cacheWrite: 0 },
  { prefix: 'gpt-3.5-turbo', input: 0.5, output: 1.5, cacheRead: 0.5, cacheWrite: 0 },

  // ── Google Gemini (cached content billed at a quarter of the input rate) ──
  { prefix: 'gemini-2.5-pro', input: 1.25, output: 10, cacheRead: 0.3125, cacheWrite: 0 },
  { prefix: 'gemini-2.5-flash', input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0 },
  { prefix: 'gemini-2.0-flash', input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0 },
  { prefix: 'gemini-1.5-flash', input: 0.075, output: 0.3, cacheRead: 0.01875, cacheWrite: 0 },
  { prefix: 'gemini-1.5-pro', input: 1.25, output: 5.0, cacheRead: 0.3125, cacheWrite: 0 },

  // ── DeepSeek ──────────────────────────────────────────────────────────────
  { prefix: 'deepseek-v3', input: 0.14, output: 0.28, cacheRead: 0.14, cacheWrite: 0 },
  { prefix: 'deepseek-chat', input: 0.14, output: 0.28, cacheRead: 0.14, cacheWrite: 0 },
  { prefix: 'deepseek-r1', input: 0.55, output: 2.19, cacheRead: 0.55, cacheWrite: 0 },
  { prefix: 'deepseek-reasoner', input: 0.55, output: 2.19, cacheRead: 0.55, cacheWrite: 0 },

  // ── Mistral (hosted only — a bare `mistral` tag is an Ollama local pull
  //    and deliberately matches nothing here) ────────────────────────────────
  { prefix: 'mistral-large', input: 2.0, output: 6.0, cacheRead: 2.0, cacheWrite: 0 },
  { prefix: 'mistral-small', input: 0.1, output: 0.3, cacheRead: 0.1, cacheWrite: 0 },
];

/** First row whose prefix is a substring of `model`, or undefined. */
export function findRate(model: string): ModelRate | undefined {
  const id = model.toLowerCase();
  return MODEL_PRICING.find((r) => id.includes(r.prefix));
}
