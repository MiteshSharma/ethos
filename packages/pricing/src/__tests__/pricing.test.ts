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
