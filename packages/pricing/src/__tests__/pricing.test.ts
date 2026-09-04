import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  estimateCost,
  findRate,
  resetUnknownModelReports,
  setUnknownModelReporter,
} from '../index';

describe('estimateCost — cache-aware rates', () => {
  it('prices each token bucket at its own rate', () => {
    // claude-sonnet-4: 3 / 15 / 0.3 / 3.75 per 1M.
    // 1000*3 + 500*15 + 2000*0.3 + 400*3.75 = 3000 + 7500 + 600 + 1500 = 12_600
    const { costUsd, basis } = estimateCost('claude-sonnet-4-6', {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 2000,
      cacheCreationTokens: 400,
    });
    expect(basis).toBe('priced');
    expect(costUsd).toBeCloseTo(12_600 / 1_000_000, 12);
  });

  it('does not price cache reads as ordinary input', () => {
    // The regression this package exists to prevent: a cached-heavy turn priced
    // at the input rate reports ~10x its real cost on Anthropic.
    const asInput = estimateCost('claude-sonnet-4-6', {
      inputTokens: 10_000,
      outputTokens: 0,
    });
    const asCacheRead = estimateCost('claude-sonnet-4-6', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 10_000,
    });
    expect(asCacheRead.costUsd).toBeLessThan(asInput.costUsd);
    expect(asCacheRead.costUsd).toBeCloseTo(asInput.costUsd / 10, 12);
  });

  it('prices cache creation above ordinary input', () => {
    const asInput = estimateCost('claude-opus-4-7', { inputTokens: 10_000, outputTokens: 0 });
    const asCacheWrite = estimateCost('claude-opus-4-7', {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 10_000,
    });
    expect(asCacheWrite.costUsd).toBeGreaterThan(asInput.costUsd);
  });

  it('treats missing cache buckets as zero', () => {
    // gpt-4o-mini: 0.15 / 0.6 → 1000*0.15 + 1000*0.6 = 750
    const { costUsd } = estimateCost('gpt-4o-mini', { inputTokens: 1000, outputTokens: 1000 });
    expect(costUsd).toBeCloseTo(750 / 1_000_000, 12);
  });

  it('resolves the same model across provider routes', () => {
    const direct = estimateCost('claude-sonnet-4-6', { inputTokens: 1000, outputTokens: 1000 });
    const bedrock = estimateCost('us.anthropic.claude-sonnet-4-20250514-v1:0', {
      inputTokens: 1000,
      outputTokens: 1000,
    });
    const openrouter = estimateCost('anthropic/claude-sonnet-4-6', {
      inputTokens: 1000,
      outputTokens: 1000,
    });
    expect(bedrock).toEqual(direct);
    expect(openrouter).toEqual(direct);
    // Gemini and Bedrock used to be hardcoded to $0 at the transport.
    expect(bedrock.costUsd).toBeGreaterThan(0);
    expect(
      estimateCost('gemini-2.5-pro', { inputTokens: 1000, outputTokens: 1000 }).costUsd,
    ).toBeGreaterThan(0);
  });

  it('prefers the more specific prefix', () => {
    expect(findRate('gpt-4o-mini')?.prefix).toBe('gpt-4o-mini');
    expect(findRate('gpt-4o-2024-08-06')?.prefix).toBe('gpt-4o');
  });
});

describe('estimateCost — unpriced and local models', () => {
  let reported: string[];

  beforeEach(() => {
    reported = [];
    resetUnknownModelReports();
    setUnknownModelReporter((model) => reported.push(model));
  });

  afterEach(() => {
    setUnknownModelReporter(undefined);
    resetUnknownModelReports();
  });

  it('returns 0 for an unknown model instead of guessing', () => {
    const { costUsd, basis } = estimateCost('some-model-nobody-has-heard-of', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(costUsd).toBe(0);
    expect(basis).toBe('unknown');
  });

  it('never silently prices an unrecognised Anthropic model as Sonnet', () => {
    // Pre-fix, llm-anthropic's table fell back to { input: 3, output: 15 } for
    // ANY unmatched id, so a typo or a model released tomorrow invented a
    // Sonnet-shaped invoice out of nothing.
    const unknown = estimateCost('claude-quintuple-9', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    const sonnet = estimateCost('claude-sonnet-4-6', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(sonnet.costUsd).toBeCloseTo(18, 12);
    expect(unknown.costUsd).toBe(0);
    expect(unknown.basis).toBe('unknown');
  });

  it('reports an unknown model exactly once per model per process', () => {
    estimateCost('mystery-model-a', { inputTokens: 10, outputTokens: 10 });
    estimateCost('mystery-model-a', { inputTokens: 99, outputTokens: 99 });
    estimateCost('mystery-model-a', { inputTokens: 1, outputTokens: 1 });
    expect(reported).toEqual(['mystery-model-a']);

    estimateCost('mystery-model-b', { inputTokens: 10, outputTokens: 10 });
    expect(reported).toEqual(['mystery-model-a', 'mystery-model-b']);
  });

  it('never reports a priced model', () => {
    estimateCost('claude-sonnet-4-6', { inputTokens: 10, outputTokens: 10 });
    expect(reported).toEqual([]);
  });

  it('treats a local-runtime call as an intentional $0 with no event', () => {
    const { costUsd, basis } = estimateCost(
      'llama3.2',
      { inputTokens: 100_000, outputTokens: 100_000 },
      { localRuntime: true },
    );
    expect(costUsd).toBe(0);
    expect(basis).toBe('local');
    expect(reported).toEqual([]);
  });

  it('does not bill a hosted rate for a same-named model pulled locally', () => {
    // `deepseek-r1` is both an Ollama pull and a hosted paid model. The runtime
    // signal is the truth; the name is not.
    const hosted = estimateCost('deepseek-r1', { inputTokens: 1_000_000, outputTokens: 0 });
    const local = estimateCost(
      'deepseek-r1',
      { inputTokens: 1_000_000, outputTokens: 0 },
      { localRuntime: true },
    );
    expect(hosted.basis).toBe('priced');
    expect(hosted.costUsd).toBeCloseTo(0.55, 12);
    expect(local.basis).toBe('local');
    expect(local.costUsd).toBe(0);
    expect(reported).toEqual([]);
  });

  it('keeps a model unreported until a sink exists', () => {
    setUnknownModelReporter(undefined);
    estimateCost('late-sink-model', { inputTokens: 1, outputTokens: 1 });
    setUnknownModelReporter((model) => reported.push(model));
    estimateCost('late-sink-model', { inputTokens: 1, outputTokens: 1 });
    expect(reported).toEqual(['late-sink-model']);
  });

  it('survives a throwing sink', () => {
    setUnknownModelReporter(() => {
      throw new Error('observability is down');
    });
    expect(() =>
      estimateCost('exploding-model', { inputTokens: 1, outputTokens: 1 }),
    ).not.toThrow();
  });
});

describe('estimateCost — whole-request tier break', () => {
  // grok-4.6: 2.00 / 6.00 / 0.50 below 200K, 4.00 / 12.00 / 1.00 above.
  it('uses the below-threshold set for a small prompt', () => {
    const { costUsd, basis } = estimateCost('grok-4.6', {
      inputTokens: 100_000,
      outputTokens: 1000,
    });
    expect(basis).toBe('priced');
    expect(costUsd).toBeCloseTo((100_000 * 2 + 1000 * 6) / 1_000_000, 12);
  });

  it('reprices the WHOLE request above the threshold, not just the overage', () => {
    const { costUsd } = estimateCost('grok-4.6', { inputTokens: 250_000, outputTokens: 1000 });
    // Every token at the above-threshold rate — no proration of the first 200K.
    expect(costUsd).toBeCloseTo((250_000 * 4 + 1000 * 12) / 1_000_000, 12);
    const prorated = (200_000 * 2 + 50_000 * 4 + 1000 * 12) / 1_000_000;
    expect(costUsd).toBeGreaterThan(prorated);
  });

  it('doubles across the cliff: a 201K prompt costs 2x a 199K one', () => {
    const under = estimateCost('grok-4.6', { inputTokens: 199_000, outputTokens: 1000 });
    const over = estimateCost('grok-4.6', { inputTokens: 201_000, outputTokens: 1000 });
    // 2K more prompt tokens, ~2.02x the bill — the whole request moved tier.
    expect(over.costUsd / under.costUsd).toBeCloseTo(2, 1);
  });

  it('treats the threshold itself as below it', () => {
    const at = estimateCost('grok-4.6', { inputTokens: 200_000, outputTokens: 0 });
    const above = estimateCost('grok-4.6', { inputTokens: 200_001, outputTokens: 0 });
    expect(at.costUsd).toBeCloseTo((200_000 * 2) / 1_000_000, 12);
    expect(above.costUsd).toBeCloseTo((200_001 * 4) / 1_000_000, 12);
  });

  it('counts cache reads toward the prompt size, not just ordinary input', () => {
    // The regression: a cached 250K-token prompt is still a 250K-token prompt to
    // xAI. Comparing `inputTokens` alone would drop it back to the cheap tier
    // exactly when prompt caching starts working on a long-context turn.
    const { costUsd } = estimateCost('grok-4.6', {
      inputTokens: 100_000,
      outputTokens: 0,
      cacheReadTokens: 150_000,
    });
    expect(costUsd).toBeCloseTo((100_000 * 4 + 150_000 * 1.0) / 1_000_000, 12);
    // Input-only comparison would have billed half this.
    expect(costUsd).toBeCloseTo(((100_000 * 2 + 150_000 * 0.5) * 2) / 1_000_000, 12);
  });

  it('does not let output tokens push a request over the threshold', () => {
    const { costUsd } = estimateCost('grok-4.3', { inputTokens: 1000, outputTokens: 500_000 });
    expect(costUsd).toBeCloseTo((1000 * 1.25 + 500_000 * 2.5) / 1_000_000, 12);
  });

  it('leaves a row without a tier break completely unchanged', () => {
    // A million-token Sonnet prompt still prices flat at $3/1M.
    const sonnet = estimateCost('claude-sonnet-4-6', { inputTokens: 1_000_000, outputTokens: 0 });
    expect(sonnet.costUsd).toBeCloseTo(3, 12);
    expect(findRate('claude-sonnet-4-6')?.tierBreak).toBeUndefined();
    const small = estimateCost('gpt-4o-mini', { inputTokens: 10, outputTokens: 10 });
    const large = estimateCost('gpt-4o-mini', { inputTokens: 10_000_000, outputTokens: 10 });
    expect(large.costUsd - small.costUsd).toBeCloseTo((9_999_990 * 0.15) / 1_000_000, 9);
  });

  it('applies each row own above-threshold rates, not a shared one', () => {
    const above = { inputTokens: 300_000, outputTokens: 1000 };
    expect(estimateCost('grok-4.5', above).costUsd).toBeCloseTo(
      (300_000 * 4 + 1000 * 12) / 1_000_000,
      12,
    );
    expect(estimateCost('grok-4.3', above).costUsd).toBeCloseTo(
      (300_000 * 2.5 + 1000 * 5) / 1_000_000,
      12,
    );
    expect(estimateCost('grok-build-0.1', above).costUsd).toBeCloseTo(
      (300_000 * 2 + 1000 * 4) / 1_000_000,
      12,
    );
  });
});

// ---------------------------------------------------------------------------
// Resolved-id guard
// ---------------------------------------------------------------------------
//
// `findRate` is a substring test over an ORDERED list with no provider
// dimension, so adding a row can reprice an id that belongs to a different
// provider — `x-ai/grok-4.6` contains `grok-4.6`, and
// packages/wiring/scripts/sources/openrouter.ts allowlists the `x-ai/grok`
// prefix, so that id is reachable today.
//
// This asserts over RESOLVED IDS, not rows. A test asserting "no existing row
// changes rate" passes vacuously in exactly the case that matters: no row
// changes, a previously-unpriced ID becomes priced. Pin the id -> outcome map
// instead, so the next row addition has to come here and say so out loud.
//
// The xAI rows decline that collision with `excludeIdsContaining: ['x-ai/']`,
// so the OpenRouter-routed ids below still resolve to no row at all.
describe('findRate — resolved-id collision guard', () => {
  /** `prefix: null` means the id resolves to no row at all (basis `unknown`). */
  const RESOLVED_IDS: ReadonlyArray<{ id: string; prefix: string | null }> = [
    // xAI direct — the ids this change exists to price.
    { id: 'grok-4.6', prefix: 'grok-4.6' },
    { id: 'grok-4.5', prefix: 'grok-4.5' },
    { id: 'grok-4.3', prefix: 'grok-4.3' },
    { id: 'grok-build-0.1', prefix: 'grok-build-0.1' },
    // Undated ids are what the catalog carries, but xAI also serves dated ones.
    { id: 'grok-4.6-0709', prefix: 'grok-4.6' },
    // Not priced: no row, and none is guessed from a sibling.
    { id: 'grok-3', prefix: null },
    { id: 'grok-2-vision-1212', prefix: null },
    // OpenRouter — allowlisted by `x-ai/grok`, so reachable. NOT priced off the
    // xAI rows: those carry xAI's direct list price, which is not what
    // OpenRouter charges. An honest unknown, decided in table.ts.
    { id: 'x-ai/grok-4.6', prefix: null },
    { id: 'x-ai/grok-4.5', prefix: null },
    { id: 'x-ai/grok-4.3', prefix: null },
    { id: 'x-ai/grok-build-0.1', prefix: null },
    { id: 'x-ai/grok-3', prefix: null },
    // Everything else reachable through OpenRouter's allowlist: unchanged.
    { id: 'anthropic/claude-sonnet-4-6', prefix: 'claude-sonnet-4' },
    { id: 'anthropic/claude-opus-4-7', prefix: 'claude-opus-4' },
    { id: 'google/gemini-2.5-pro', prefix: 'gemini-2.5-pro' },
    { id: 'openai/gpt-4o-mini', prefix: 'gpt-4o-mini' },
    { id: 'deepseek/deepseek-chat', prefix: 'deepseek-chat' },
    { id: 'mistralai/mistral-large', prefix: 'mistral-large' },
    { id: 'meta-llama/llama-3.3-70b-instruct', prefix: null },
    { id: 'moonshotai/kimi-k2.6', prefix: null },
    // Direct ids on other providers, and the local pulls that must stay unpriced.
    { id: 'claude-sonnet-4-6', prefix: 'claude-sonnet-4' },
    { id: 'us.anthropic.claude-sonnet-4-20250514-v1:0', prefix: 'claude-sonnet-4' },
    { id: 'gpt-5.4', prefix: null },
    { id: 'llama3.2', prefix: null },
    { id: 'mistral', prefix: null },
    { id: 'qwen3-coder', prefix: null },
  ];

  /**
   * The complete set of ids allowed to price off an xAI row: direct xAI ids
   * only, because those rows carry xAI's DIRECT list price. Nothing reached
   * through a reseller route belongs here — adding one means claiming that
   * reseller bills at xAI's rate, which is the claim table.ts declined to make.
   * Widening this set is a pricing decision, not a test fix.
   */
  const PRICED_VIA_XAI_ROW = new Set([
    'grok-4.6',
    'grok-4.5',
    'grok-4.3',
    'grok-build-0.1',
    'grok-4.6-0709',
  ]);

  const XAI_PREFIXES = new Set(['grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-build-0.1']);

  it('resolves every reachable id to exactly the pinned row', () => {
    for (const { id, prefix } of RESOLVED_IDS) {
      expect(findRate(id)?.prefix ?? null, `id: ${id}`).toBe(prefix);
    }
  });

  it('reports the pinned basis for every reachable id', () => {
    for (const { id, prefix } of RESOLVED_IDS) {
      const { basis } = estimateCost(id, { inputTokens: 1000, outputTokens: 1000 });
      expect(basis, `id: ${id}`).toBe(prefix === null ? 'unknown' : 'priced');
    }
  });

  it('prices no id off an xAI row beyond the decided set', () => {
    const viaXaiRow = RESOLVED_IDS.filter(
      ({ prefix }) => prefix !== null && XAI_PREFIXES.has(prefix),
    )
      .map(({ id }) => id)
      .sort();
    expect(viaXaiRow).toEqual([...PRICED_VIA_XAI_ROW].sort());
  });

  it('keeps a reseller-routed Grok id unknown at every prompt size', () => {
    // The tier break must not become a second way in: an excluded row is not
    // consulted at all, so a 300K-token OpenRouter turn is still $0/unknown
    // while the same prompt on the direct id bills at the above-threshold rate.
    const long = { inputTokens: 300_000, outputTokens: 1000 };
    expect(estimateCost('x-ai/grok-4.6', long)).toEqual({ costUsd: 0, basis: 'unknown' });
    expect(estimateCost('grok-4.6', long).costUsd).toBeCloseTo(
      (300_000 * 4 + 1000 * 12) / 1_000_000,
      12,
    );
  });

  it('leaves a non-xAI id resolving to a non-xAI row', () => {
    // The reverse collision: an xAI row must not swallow another provider's id.
    for (const { id, prefix } of RESOLVED_IDS) {
      if (id.includes('grok')) continue;
      expect(prefix === null || !XAI_PREFIXES.has(prefix), `id: ${id}`).toBe(true);
    }
  });
});
