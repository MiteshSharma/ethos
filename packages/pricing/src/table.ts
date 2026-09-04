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
// and OpenRouter's `anthropic/claude-sonnet-4-6` without three rows. A row that
// must NOT serve one of those routes says so with `excludeIdsContaining` — see
// the xAI block for the one case that uses it, and why.
//
// PROVENANCE. Anthropic and the pre-existing OpenAI/Gemini/DeepSeek/Mistral
// input+output rates are carried over verbatim from the two tables this package
// replaces, so no priced model changes price in this commit. Cache-read rates
// and the newly-priced rows (gemini-2.5-*, deepseek-chat/reasoner) come from the
// providers' published list prices. A model with no row is NOT guessed at — see
// `estimateCost`, which returns 0 and reports it as unpriced.

/**
 * A whole-request reprice above a prompt-size threshold.
 *
 * xAI bills a 201K-token prompt at DOUBLE a 199K one end to end — the overage
 * is not priced separately, the entire request moves to the second rate set. So
 * this is a rate set, not a marginal rate: `estimateCost` picks one group or the
 * other and never splits tokens across the two.
 */
export interface TierBreak {
  /**
   * Prompt tokens above which the whole request bills at the rates below.
   * "Prompt tokens" is every bucket that occupies the context window — ordinary
   * input plus cache reads plus cache writes — not `input` alone, because a
   * cached long-context turn is still a long-context turn to the provider.
   */
  abovePromptTokens: number;
  /** USD per 1M ordinary input (prompt) tokens above the threshold. */
  input: number;
  /** USD per 1M output (completion) tokens above the threshold. */
  output: number;
  /** USD per 1M cache-read tokens above the threshold. */
  cacheRead: number;
  /** USD per 1M cache-write tokens above the threshold. */
  cacheWrite: number;
}

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
  /**
   * Optional. Present only for providers that reprice the whole request above a
   * prompt size (today: xAI). A row without it prices exactly as it always has.
   */
  tierBreak?: TierBreak;
  /**
   * Optional. Lower-case substrings that DISQUALIFY this row: an id containing
   * any of them skips the row and keeps looking, so it falls through to a later
   * row or to no row at all (`basis: 'unknown'`).
   *
   * This exists because `prefix` is a substring test with no provider
   * dimension, so a row carrying one provider's DIRECT price also matches the
   * same model served by a reseller at a different price. A row without this
   * field matches exactly as it always has.
   */
  excludeIdsContaining?: readonly string[];
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

  // ── xAI Grok ──────────────────────────────────────────────────────────────
  //
  // Rates from https://docs.x.ai/docs/models as of 2026-09-03. Date-stamped
  // deliberately: xAI's pricing PAGE moves faster than its docs, so treat these
  // as stale on sight and re-fetch before editing.
  //
  // Every row carries a 200K-token `tierBreak` because xAI reprices the ENTIRE
  // request above that prompt size — see `TierBreak`. With grok-4.6 at 500K and
  // grok-4.3 at 1M context, crossing the break is the expected case here, not an
  // edge case, and a flat rate would under-report those turns by 2x.
  //
  // `cacheWrite: 0` at BOTH tiers is not a measured xAI rate — xAI publishes no
  // cache-write price, and the OpenAI-compat transport these models are served
  // through reports `cacheCreationTokens: 0` on every call
  // (extensions/llm-openai-compat/src/transport.ts:289), so the bucket is always
  // empty. 0 is this table's standing convention for "provider does not bill a
  // distinct cache-write" (see the header). It is a placeholder, not a finding:
  // if xAI starts billing cache writes, this is the number that is wrong.
  //
  // OPENROUTER COLLISION, DECLINED. `findRate` is a substring test, so
  // `x-ai/grok-4.6` would otherwise match the bare `grok-4.6` row below. Those
  // ids are already reachable — packages/wiring/scripts/sources/openrouter.ts
  // allowlists the `x-ai/grok` prefix — and pricing them off these rows would
  // report xAI's DIRECT list price for a call OpenRouter billed at its own.
  //
  // So every row here carries `excludeIdsContaining: ['x-ai/']`, and an
  // OpenRouter-routed Grok id keeps reporting `basis: 'unknown'` exactly as it
  // did before these rows existed. The reasoning that would have justified
  // reusing the direct price — that OpenRouter resells at the upstream
  // per-token rate and takes its margin elsewhere — is an unverified premise
  // about someone else's margin model, and an honest unknown beats a
  // confidently-wrong number. Pricing those ids needs OpenRouter's own rates in
  // an `x-ai/`-prefixed row; until someone has them, there is no row.
  {
    prefix: 'grok-4.6',
    input: 2.0,
    output: 6.0,
    cacheRead: 0.5,
    cacheWrite: 0,
    excludeIdsContaining: ['x-ai/'],
    tierBreak: {
      abovePromptTokens: 200_000,
      input: 4.0,
      output: 12.0,
      cacheRead: 1.0,
      cacheWrite: 0,
    },
  },
  {
    prefix: 'grok-4.5',
    input: 2.0,
    output: 6.0,
    cacheRead: 0.3,
    cacheWrite: 0,
    excludeIdsContaining: ['x-ai/'],
    tierBreak: {
      abovePromptTokens: 200_000,
      input: 4.0,
      output: 12.0,
      cacheRead: 0.6,
      cacheWrite: 0,
    },
  },
  {
    prefix: 'grok-4.3',
    input: 1.25,
    output: 2.5,
    cacheRead: 0.2,
    cacheWrite: 0,
    excludeIdsContaining: ['x-ai/'],
    tierBreak: {
      abovePromptTokens: 200_000,
      input: 2.5,
      output: 5.0,
      cacheRead: 0.4,
      cacheWrite: 0,
    },
  },
  {
    prefix: 'grok-build-0.1',
    input: 1.0,
    output: 2.0,
    cacheRead: 0.2,
    cacheWrite: 0,
    excludeIdsContaining: ['x-ai/'],
    tierBreak: {
      abovePromptTokens: 200_000,
      input: 2.0,
      output: 4.0,
      cacheRead: 0.4,
      cacheWrite: 0,
    },
  },
];

/**
 * First row whose prefix is a substring of `model` and whose
 * `excludeIdsContaining` does not also match it, or undefined.
 */
export function findRate(model: string): ModelRate | undefined {
  const id = model.toLowerCase();
  return MODEL_PRICING.find(
    (r) => id.includes(r.prefix) && !r.excludeIdsContaining?.some((x) => id.includes(x)),
  );
}
