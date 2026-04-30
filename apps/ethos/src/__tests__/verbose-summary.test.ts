import { describe, expect, it } from 'vitest';
import { formatVerboseSummary } from '../commands/verbose-timing';

const BASE = 1_000_000;

describe('formatVerboseSummary', () => {
  it('starts with ↳ and contains llm + total', () => {
    const result = formatVerboseSummary({
      turnStart: BASE,
      turnEnd: BASE + 4100,
      firstTextDeltaAt: BASE + 800,
      toolDurations: [],
      turnUsage: null,
    });
    expect(result).toMatch(/^↳ llm \d+\.\d+s/);
    expect(result).toContain('total');
  });

  it('includes TTFT when firstTextDeltaAt is set', () => {
    const result = formatVerboseSummary({
      turnStart: BASE,
      turnEnd: BASE + 4100,
      firstTextDeltaAt: BASE + 800,
      toolDurations: [],
      turnUsage: null,
    });
    expect(result).toContain('TTFT 0.8s');
  });

  it('omits TTFT when firstTextDeltaAt is null', () => {
    const result = formatVerboseSummary({
      turnStart: BASE,
      turnEnd: BASE + 4100,
      firstTextDeltaAt: null,
      toolDurations: [],
      turnUsage: null,
    });
    expect(result).not.toContain('TTFT');
  });

  it('includes tools clause with plural label for multiple tools', () => {
    const result = formatVerboseSummary({
      turnStart: BASE,
      turnEnd: BASE + 5000,
      firstTextDeltaAt: null,
      toolDurations: [300, 300],
      turnUsage: null,
    });
    expect(result).toContain('tools');
    expect(result).toContain('2 calls');
  });

  it('uses singular "call" for one tool', () => {
    const result = formatVerboseSummary({
      turnStart: BASE,
      turnEnd: BASE + 2000,
      firstTextDeltaAt: null,
      toolDurations: [500],
      turnUsage: null,
    });
    expect(result).toContain('1 call)');
    expect(result).not.toContain('calls');
  });

  it('omits tools clause when no tools ran', () => {
    const result = formatVerboseSummary({
      turnStart: BASE,
      turnEnd: BASE + 2000,
      firstTextDeltaAt: BASE + 500,
      toolDurations: [],
      turnUsage: null,
    });
    expect(result).not.toContain('tools');
  });

  it('formats large token counts with k suffix', () => {
    const result = formatVerboseSummary({
      turnStart: BASE,
      turnEnd: BASE + 3000,
      firstTextDeltaAt: null,
      toolDurations: [],
      turnUsage: { inputTokens: 2100, outputTokens: 380, estimatedCostUsd: 0.012 },
    });
    expect(result).toContain('2.1k in');
    expect(result).toContain('380 out');
    expect(result).toContain('$0.012');
  });

  it('omits cost when estimatedCostUsd is 0', () => {
    const result = formatVerboseSummary({
      turnStart: BASE,
      turnEnd: BASE + 3000,
      firstTextDeltaAt: null,
      toolDurations: [],
      turnUsage: { inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0 },
    });
    expect(result).not.toContain('$');
  });

  it('omits usage section entirely when turnUsage is null', () => {
    const result = formatVerboseSummary({
      turnStart: BASE,
      turnEnd: BASE + 3000,
      firstTextDeltaAt: null,
      toolDurations: [],
      turnUsage: null,
    });
    expect(result).not.toContain(' in');
    expect(result).not.toContain(' out');
  });

  it('llm time = total - tools wall time', () => {
    // total = 5s, tools = 1s, so llm should be ~4s
    const result = formatVerboseSummary({
      turnStart: BASE,
      turnEnd: BASE + 5000,
      firstTextDeltaAt: null,
      toolDurations: [1000],
      turnUsage: null,
    });
    expect(result).toContain('llm 4.0s');
    expect(result).toContain('total 5.0s');
  });
});
