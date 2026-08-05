// Lane 1(b/c/e) + D8 — the shared static-floor measurement, the warn-first
// startup diagnostic, and the window-scaled result budget with its ceiling
// (#111762 cap-the-cap).

import { describe, expect, it } from 'vitest';
import {
  evaluateContextFit,
  measureStaticFloor,
  outputReserveTokens,
  RESULT_BUDGET_CEILING_CHARS,
  RESULT_BUDGET_FLOOR_CHARS,
  resolveResultBudget,
} from '../static-floor';

describe('measureStaticFloor (D8 — one arithmetic)', () => {
  it('produces the exact number the previous inline estimates computed', () => {
    const floor = measureStaticFloor({
      soulChars: 3_141,
      toolSchemaChars: 19_007,
      toolCount: 12,
      preludeChars: 1_602,
    });
    // build-agent-loop's legacy formula: ceil((soul + schemas + prelude) / 4).
    expect(floor.tokens).toBe(Math.ceil((3_141 + 19_007 + 1_602) / 4));
    expect(floor.totalChars).toBe(3_141 + 19_007 + 1_602);
    expect(floor.toolCount).toBe(12);
  });

  it('breaks the floor down per component', () => {
    const floor = measureStaticFloor({
      soulChars: 400,
      toolSchemaChars: 8_000,
      toolCount: 4,
      preludeChars: 100,
    });
    expect(floor.components.map((c) => c.name)).toEqual([
      'SOUL.md',
      'tool schemas',
      'injection-defense prelude',
    ]);
    const schemas = floor.components.find((c) => c.name === 'tool schemas');
    expect(schemas?.tokens).toBe(2_000);
  });
});

describe('evaluateContextFit (Lane 1b — warn-first startup diagnostic)', () => {
  const bigFloor = measureStaticFloor({
    soulChars: 3_200, // ~800 tokens
    toolSchemaChars: 19_200, // ~4,800 tokens — the largest component
    toolCount: 12,
    preludeChars: 1_600, // ~400 tokens
  });

  it('a fitting personality produces no message', () => {
    const fit = evaluateContextFit({
      personalityId: 'summarizer',
      model: 'qwen3:8b',
      windowTokens: 200_000,
      floor: bigFloor,
    });
    expect(fit.message).toBeUndefined();
    expect(fit.compactibleTokens).toBeGreaterThan(0);
  });

  it('names the personality, model, window, and LARGEST component with token count', () => {
    // static 6,000 + reserve 4,096 > 8,192 → unrunnable.
    const fit = evaluateContextFit({
      personalityId: 'researcher',
      model: 'qwen3:8b',
      windowTokens: 8_192,
      floor: bigFloor,
    });
    expect(fit.compactibleTokens).toBeLessThanOrEqual(0);
    expect(fit.message).toContain('personality `researcher` cannot run on `qwen3:8b`');
    expect(fit.message).toContain('(8,192 tokens)');
    expect(fit.message).toContain('static prefix 6,000');
    expect(fit.message).toContain('output reserve 4,096');
    expect(fit.message).toContain('Largest contributor: tool schemas (4,800 tokens, 12 tools)');
  });

  it('mirrors the gate reserve exactly: min(4096, window/2)', () => {
    expect(outputReserveTokens(200_000)).toBe(4_096);
    expect(outputReserveTokens(4_096)).toBe(2_048);
  });
});

describe('resolveResultBudget (Lane 1c/1e)', () => {
  it('on an 8,192 window the budget resolves below the compactible region (numeric)', () => {
    const staticFloorTokens = 1_000;
    const budget = resolveResultBudget({ windowTokens: 8_192, staticFloorTokens });
    // compactible = 8,192 − 4,096 reserve − 1,000 static = 3,096 tokens.
    const compactibleChars = (8_192 - 4_096 - staticFloorTokens) * 4;
    expect(budget).toBe(Math.floor(compactibleChars * 0.25)); // 3,096
    expect(budget).toBeLessThan(compactibleChars);
    expect(budget).toBeLessThan(RESULT_BUDGET_CEILING_CHARS);
  });

  it('#111762 — increasing the window does NOT raise the cap past its ceiling', () => {
    const at200k = resolveResultBudget({ windowTokens: 200_000, staticFloorTokens: 5_000 });
    const at1m = resolveResultBudget({ windowTokens: 1_000_000, staticFloorTokens: 5_000 });
    expect(at200k).toBe(RESULT_BUDGET_CEILING_CHARS);
    expect(at1m).toBe(RESULT_BUDGET_CEILING_CHARS);
    // Monotone growth below the ceiling, flat at it.
    const at8k = resolveResultBudget({ windowTokens: 8_192, staticFloorTokens: 0 });
    const at16k = resolveResultBudget({ windowTokens: 16_384, staticFloorTokens: 0 });
    expect(at8k).toBeLessThan(at16k);
    expect(at16k).toBeLessThanOrEqual(RESULT_BUDGET_CEILING_CHARS);
  });

  it('an explicit override can lower the budget but never exceed the ceiling', () => {
    expect(
      resolveResultBudget({ windowTokens: 200_000, staticFloorTokens: 0, configured: 3_000 }),
    ).toBe(3_000);
    expect(
      resolveResultBudget({ windowTokens: 200_000, staticFloorTokens: 0, configured: 500_000 }),
    ).toBe(RESULT_BUDGET_CEILING_CHARS);
  });

  it('a pathologically small window floors at the minimum useful budget', () => {
    // 4,096 window: compactible = 4,096 − 2,048 − 1,000 = 1,048 tokens →
    // window cap 1,048 chars → floored to 2,000.
    expect(resolveResultBudget({ windowTokens: 4_096, staticFloorTokens: 1_000 })).toBe(
      RESULT_BUDGET_FLOOR_CHARS,
    );
  });
});
