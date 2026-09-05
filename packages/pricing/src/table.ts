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
// the xAI block (reseller ids) and the `gpt-5.4` row (differently-priced
// siblings that contain the prefix) for the two cases that use it, and why.
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
  //
  // Current-generation rows verified 2026-09-05 against
  // https://platform.claude.com/docs/en/about-claude/pricing. Cache write is
  // the 5-minute rate (1.25x input); cache read is 0.1x input everywhere except
  // Fable 5.1, which the page prices at 0.025x ($0.25/MTok). Fable 5 reads at
  // the standard 0.1x ($1/MTok), so the two Fable rows differ on that column
  // only — and `claude-fable-5-1` must precede `claude-fable-5` or the
  // substring test hands 5.1 the 5 rate.
  //
  // The dotted-version rows (`claude-opus-4-8`, `-4-7`, `-4-6`) sit ABOVE the
  // bare `claude-opus-4` row on purpose: that row carries the retired Opus 4 /
  // 4.1 price (15/75), and without the specific rows every 4.x id fell through
  // to it at 3x its real rate. Same shape for `claude-haiku-4-5` over
  // `claude-haiku-4` and `claude-sonnet-4-6` over `claude-sonnet-4`.
  { prefix: 'claude-fable-5-1', input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  { prefix: 'claude-fable-5', input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 },
  { prefix: 'claude-opus-5', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { prefix: 'claude-opus-4-8', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { prefix: 'claude-opus-4-7', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { prefix: 'claude-opus-4-6', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { prefix: 'claude-opus-4', input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { prefix: 'claude-sonnet-5', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  { prefix: 'claude-sonnet-4-6', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { prefix: 'claude-sonnet-4', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { prefix: 'claude-haiku-4-5', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { prefix: 'claude-haiku-4', input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1.0 },
  { prefix: 'claude-3-7-sonnet', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { prefix: 'claude-3-5-sonnet', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { prefix: 'claude-3-5-haiku', input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1.0 },
  { prefix: 'claude-3-opus', input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },

  // ── OpenAI ────────────────────────────────────────────────────────────────
  //
  // Current-generation rows verified 2026-09-05 against
  // https://developers.openai.com/api/docs/pricing; `cacheRead` is the page's
  // "cached input" column (0.1x input on every current model — the older
  // gpt-4o rows below bill it at 0.5x, which is what those models charged).
  //
  // The page also lists a long-context rate for gpt-6-astra, the gpt-5.6
  // family, gpt-5.5 and gpt-5.4 (gpt-5.5/5.4 above 272K prompt tokens; the
  // others state no threshold) but does NOT say whether the whole request
  // reprices or only the overage. `TierBreak` encodes whole-request repricing,
  // so these rows stay flat at the short-context rate rather than assert a
  // billing shape the page does not state; a long-context turn under-reports
  // until someone confirms the semantics.
  //
  // Ordering: `gpt-5.4-mini` before `gpt-5.4`. There is deliberately no bare
  // `gpt-5` row, so an unlisted 5.x id stays `basis: 'unknown'` instead of
  // being priced off a sibling. The `gpt-5.4` row excludes `gpt-5.4-pro` and
  // `gpt-5.4-nano` for the same reason: both are in the model catalog
  // (packages/wiring/src/model-catalog.ts), both contain `gpt-5.4`, and neither
  // bills at the base 5.4 rate — they stay unknown until they get their own row.
  { prefix: 'gpt-6-astra', input: 10, output: 50, cacheRead: 1.0, cacheWrite: 0 },
  { prefix: 'gpt-5.6-sol', input: 4, output: 20, cacheRead: 0.4, cacheWrite: 0 },
  { prefix: 'gpt-5.6-terra', input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  { prefix: 'gpt-5.6-luna', input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0 },
  { prefix: 'gpt-5.5', input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  { prefix: 'gpt-5.4-mini', input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  {
    prefix: 'gpt-5.4',
    input: 2.5,
    output: 15,
    cacheRead: 0.25,
    cacheWrite: 0,
    excludeIdsContaining: ['gpt-5.4-pro', 'gpt-5.4-nano'],
  },
  { prefix: 'gpt-5.3-codex', input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  // Older OpenAI rows: cached input billed at half the input rate.
  { prefix: 'gpt-4o-mini', input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
  { prefix: 'gpt-4o', input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
  { prefix: 'gpt-4-turbo', input: 10, output: 30, cacheRead: 10, cacheWrite: 0 },
  { prefix: 'gpt-4', input: 30, output: 60, cacheRead: 30, cacheWrite: 0 },

  // ── Google Gemini ─────────────────────────────────────────────────────────
  //
  // 3.x rows verified 2026-09-05 against
  // https://ai.google.dev/gemini-api/docs/pricing (paid tier, standard, text);
  // `cacheRead` is the page's context-caching rate (0.1x input on 3.x; the 2.5
  // and earlier rows below bill it at a quarter of input, as those models did).
  //
  // gemini-3.8/3.7/3.6-flash share one price, and the page schedules it to
  // DOUBLE on 2027-01-01 (1.50/7.50, cache 0.15) — re-verify then.
  // gemini-3.1-pro-preview reprices above 200K prompt tokens (4/18, cache
  // 0.40); the row is flat at the ≤200K rate for the same reason as the OpenAI
  // block — the page does not state whole-request vs overage semantics.
  //
  // Ordering: `gemini-3.5-flash-lite` before `gemini-3.5-flash`.
  { prefix: 'gemini-3.8-flash', input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
  { prefix: 'gemini-3.7-flash', input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
  { prefix: 'gemini-3.6-flash', input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
  { prefix: 'gemini-3.5-flash-lite', input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
  { prefix: 'gemini-3.5-flash', input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
  { prefix: 'gemini-3.1-pro-preview', input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  // Older Gemini rows: cached content billed at a quarter of the input rate.
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
