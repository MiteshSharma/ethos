// T3 — compaction gate hardening: output-budget reserve + small-window safety
// factor. Drives `maybeCompact` directly (same harness style as
// third-party-engine.test.ts) so the gate arithmetic is asserted in isolation.

import type { ContextEngineCompactInput, Message, PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { maybeCompact } from '../agent-loop/compaction';
import { DefaultContextEngineRegistry } from '../context-engines/registry';

// A spy engine records whether the framework gate let it run, and keeps only
// the first + last message when it does.
function createSpyEngine() {
  let compactCalled = false;
  return {
    get compactCalled() {
      return compactCalled;
    },
    name: 'spy_engine' as const,
    async compact(opts: ContextEngineCompactInput) {
      compactCalled = true;
      const msgs = opts.messages;
      const kept =
        msgs.length <= 2 ? msgs : [msgs[0], msgs[msgs.length - 1]].filter((m): m is Message => !!m);
      return { messages: kept, notes: 'dropped middle' };
    },
    shouldCompact() {
      return true;
    },
  };
}

function registryWith(engine: ReturnType<typeof createSpyEngine>) {
  const registry = new DefaultContextEngineRegistry();
  registry.register(engine);
  return registry;
}

const sessionMock = {
  recordCompression: async () => ({}),
  updateUsage: async () => {},
  recordCompactionTurn: async () => {},
  // biome-ignore lint/suspicious/noExplicitAny: standard test mock
} as any;

const personality: PersonalityConfig = {
  id: 'test',
  name: 'Test',
  context_engine: 'spy_engine',
};

function userMsg(text: string): Message {
  return { role: 'user', content: text };
}

// Build a 4-message list of roughly `chars` total characters.
function messagesOfSize(chars: number): Message[] {
  const per = Math.floor(chars / 4);
  return [
    userMsg('x'.repeat(per)),
    userMsg('y'.repeat(per)),
    userMsg('z'.repeat(per)),
    userMsg('w'.repeat(chars - per * 3)),
  ];
}

const meta = { sessionId: 's1', sessionKey: 'cli:s1', turnNumber: 1, lastCompactionTurn: 0 };

describe('T3 — small-window safety factor (code-heavy undershoot case)', () => {
  it('compacts an 8k-window code-heavy session that the old input-only char/4 gate would have let overflow', async () => {
    const engine = createSpyEngine();
    // 8192 window, no output reserve (isolate the safety factor).
    // Old gate: pressure = 0.8 * 8192 = 6553 tokens. Four dense-code turns of
    // ~24_000 chars total are ~6000 char/4 tokens → the OLD gate would NOT
    // fire (overflow risk on a real local tokenizer that runs hotter on code).
    // New gate: 6000 * 1.15 = 6900 > 6553 → fires.
    const codeLine = 'const f=(a,b)=>{return a?.b??[...c].map(x=>x|0);};'; // ~49 chars
    const codeHeavy: Message[] = [
      userMsg(codeLine.repeat(130)),
      userMsg(codeLine.repeat(130)),
      userMsg(codeLine.repeat(130)),
      userMsg(codeLine.repeat(130)),
    ];
    const result = await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 8_192 } as any,
        contextEngines: registryWith(engine),
        session: sessionMock,
        reservedOutputTokens: 0,
      },
      codeHeavy,
      '',
      personality,
      meta,
    );
    expect(engine.compactCalled).toBe(true);
    expect(result.messages.length).toBeLessThan(codeHeavy.length);
  });

  it('does NOT compact when even the inflated estimate stays under the gate', async () => {
    const engine = createSpyEngine();
    // ~16_000 chars → 4000 char/4 tokens → *1.15 = 4600 < gate 6553.
    const result = await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 8_192 } as any,
        contextEngines: registryWith(engine),
        session: sessionMock,
        reservedOutputTokens: 0,
      },
      messagesOfSize(16_000),
      '',
      personality,
      meta,
    );
    expect(engine.compactCalled).toBe(false);
    expect(result.messages.length).toBe(4);
  });
});

describe('T3 — output-budget reserve is counted against the headroom', () => {
  // Same input; a large max_tokens reserves more of the window → compacts,
  // while a tiny max_tokens leaves room → does not.
  // 8192 window, small-window factor 1.15.
  //   tiny reserve (100): inputWindow=8092, pressure=floor(8092*0.8)=6473.
  //   large reserve (4000): inputWindow=4192, pressure=floor(4192*0.8)=3353.
  // Input ~12_800 chars → 3200 char/4 tokens → *1.15 = 3680.
  //   3680 > 3353 (large → fires) and 3680 < 6473 (tiny → no fire).
  it('compacts earlier with a large output budget', async () => {
    const engine = createSpyEngine();
    await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 8_192 } as any,
        contextEngines: registryWith(engine),
        session: sessionMock,
        reservedOutputTokens: 4_000,
      },
      messagesOfSize(12_800),
      '',
      personality,
      meta,
    );
    expect(engine.compactCalled).toBe(true);
  });

  it('does not compact the same input with a tiny output budget', async () => {
    const engine = createSpyEngine();
    await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 8_192 } as any,
        contextEngines: registryWith(engine),
        session: sessionMock,
        reservedOutputTokens: 100,
      },
      messagesOfSize(12_800),
      '',
      personality,
      meta,
    );
    expect(engine.compactCalled).toBe(false);
  });
});

describe('§5 — configurable pressure/target thresholds', () => {
  // 8192 window, reservedOutputTokens 0 (isolate), small-window factor 1.15.
  //   messagesOfSize(17400) → char/4 ≈ 4352 tok → *1.15 ≈ 5005.
  //   default pressure 0.8 → gate floor(8192*0.8)=6553: 5005 < 6553 → no compact.
  //   configured pressure 0.5 → gate floor(8192*0.5)=4096: 5005 > 4096 → compact.
  it('gates at the configured pressure, not the 0.8 default', async () => {
    const withOverride = createSpyEngine();
    await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 8_192 } as any,
        contextEngines: registryWith(withOverride),
        session: sessionMock,
        reservedOutputTokens: 0,
        pressure: 0.5,
      },
      messagesOfSize(17_400),
      '',
      personality,
      meta,
    );
    expect(withOverride.compactCalled).toBe(true);

    const defaultGate = createSpyEngine();
    await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 8_192 } as any,
        contextEngines: registryWith(defaultGate),
        session: sessionMock,
        reservedOutputTokens: 0,
      },
      messagesOfSize(17_400),
      '',
      personality,
      meta,
    );
    expect(defaultGate.compactCalled).toBe(false);
  });

  it('passes the configured target fraction to the engine', async () => {
    let seenTarget: number | undefined;
    // Name must match personality.context_engine ('spy_engine') so the gate
    // resolves to this engine rather than falling back to drop_oldest.
    const engine = {
      name: 'spy_engine' as const,
      async compact(opts: ContextEngineCompactInput) {
        seenTarget = opts.targetTokens;
        return { messages: opts.messages, notes: 'noop' };
      },
      shouldCompact() {
        return true;
      },
    };
    const registry = new DefaultContextEngineRegistry();
    registry.register(engine);
    // ~28_000 chars → char/4 7000 tok → *1.15 = 8050 > gate 6553 → fires.
    await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 8_192 } as any,
        contextEngines: registry,
        session: sessionMock,
        reservedOutputTokens: 0,
        target: 0.5,
      },
      messagesOfSize(28_000),
      '',
      personality,
      meta,
    );
    // target = floor(8192 * 0.5) = 4096
    expect(seenTarget).toBe(4_096);
  });
});

describe('§5 — per-model charsPerToken gate estimator', () => {
  // 8192 window, reservedOutputTokens 0, default pressure 0.8 → gate 6553.
  //   messagesOfSize(21_000): char/4 ≈ 5252 → *1.15 ≈ 6040 < 6553 → no compact.
  //                           chars/3 = 7000 > 6553 → compact.
  // Fewer chars-per-token → more tokens → higher pressure → gates earlier.
  it('gates earlier than char/4 for the same text (charsPerToken: 3)', async () => {
    const cptEngine = createSpyEngine();
    await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 8_192 } as any,
        contextEngines: registryWith(cptEngine),
        session: sessionMock,
        reservedOutputTokens: 0,
        charsPerToken: 3,
      },
      messagesOfSize(21_000),
      '',
      personality,
      meta,
    );
    expect(cptEngine.compactCalled).toBe(true);

    const char4Engine = createSpyEngine();
    await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 8_192 } as any,
        contextEngines: registryWith(char4Engine),
        session: sessionMock,
        reservedOutputTokens: 0,
      },
      messagesOfSize(21_000),
      '',
      personality,
      meta,
    );
    expect(char4Engine.compactCalled).toBe(false);
  });

  it('does NOT stack the small-window 1.15 factor on top of charsPerToken', async () => {
    // 18_000 chars, charsPerToken 3 → estimate = 18000/3 = 6000 ≤ gate 6553 →
    // no compaction. If the generic 1.15 factor were wrongly applied on top,
    // 6000 * 1.15 = 6900 > 6553 would compact. Asserting NO compaction proves
    // the effective estimate is chars/charsPerToken, not chars/charsPerToken*1.15.
    const engine = createSpyEngine();
    const result = await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 8_192 } as any,
        contextEngines: registryWith(engine),
        session: sessionMock,
        reservedOutputTokens: 0,
        charsPerToken: 3,
      },
      messagesOfSize(18_000),
      '',
      personality,
      meta,
    );
    expect(engine.compactCalled).toBe(false);
    expect(result.messages.length).toBe(4);
  });
});

describe('Phase 1c — model-aware gate, actuals-first', () => {
  // A 32k local model gates at ~0.8 × 32k ≈ 25.6k (NOT the 157k a 200k default
  // would imply). The signal is the previous turn's ACTUAL input tokens.
  it('a 32k model gates at ~26k on the actual input-token signal', async () => {
    const over = createSpyEngine();
    await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 32_000 } as any,
        contextEngines: registryWith(over),
        session: sessionMock,
        reservedOutputTokens: 0,
        lastActualInputTokens: 26_000, // just above the ~25.6k gate
      },
      [userMsg('a'), userMsg('b')],
      '',
      personality,
      meta,
    );
    expect(over.compactCalled).toBe(true);

    const under = createSpyEngine();
    await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 32_000 } as any,
        contextEngines: registryWith(under),
        session: sessionMock,
        reservedOutputTokens: 0,
        lastActualInputTokens: 25_000, // just below the ~25.6k gate
      },
      [userMsg('a'), userMsg('b')],
      '',
      personality,
      meta,
    );
    expect(under.compactCalled).toBe(false);
  });

  it('subtracts measured static (system+tools) so pressure applies to the messages slice', async () => {
    // window 32k, pressure 0.8. With static=20k the messages budget is
    // (32k−20k)×0.8 = 9.6k; an actual input of 27k is a 7k messages slice —
    // under budget → NO compaction. The SAME 27k WITHOUT static subtraction is
    // above the whole-window 25.6k gate → would compact. Proves the slice math.
    const withStatic = createSpyEngine();
    await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 32_000 } as any,
        contextEngines: registryWith(withStatic),
        session: sessionMock,
        reservedOutputTokens: 0,
        lastActualInputTokens: 27_000,
        staticTokens: 20_000,
      },
      [userMsg('a'), userMsg('b')],
      '',
      personality,
      meta,
    );
    expect(withStatic.compactCalled).toBe(false);

    const noStatic = createSpyEngine();
    await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 32_000 } as any,
        contextEngines: registryWith(noStatic),
        session: sessionMock,
        reservedOutputTokens: 0,
        lastActualInputTokens: 27_000,
      },
      [userMsg('a'), userMsg('b')],
      '',
      personality,
      meta,
    );
    expect(noStatic.compactCalled).toBe(true);
  });

  it('adds the configurable gateDelta to the actual input signal', async () => {
    const engine = createSpyEngine();
    await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 32_000 } as any,
        contextEngines: registryWith(engine),
        session: sessionMock,
        reservedOutputTokens: 0,
        lastActualInputTokens: 25_000, // under the gate alone
        gateDelta: 2_000, // 25k + 2k = 27k > 25.6k → fires
      },
      [userMsg('a'), userMsg('b')],
      '',
      personality,
      meta,
    );
    expect(engine.compactCalled).toBe(true);
  });
});

describe('T3 — large (Anthropic 200k) window behavior unchanged', () => {
  it('does not compact below the pressure gate', async () => {
    const engine = createSpyEngine();
    // ~600_000 chars → 150_000 char/4 tokens. Effective pressure at 200k with
    // the default 4k reserve is ~156_723 (>150_000) → no compaction, and no
    // safety-factor inflation at 200k.
    const result = await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 200_000 } as any,
        contextEngines: registryWith(engine),
        session: sessionMock,
      },
      messagesOfSize(600_000),
      '',
      personality,
      meta,
    );
    expect(engine.compactCalled).toBe(false);
    expect(result.messages.length).toBe(4);
  });

  it('compacts above the pressure gate', async () => {
    const engine = createSpyEngine();
    // ~700_000 chars → 175_000 char/4 tokens > 156_723 effective gate → fires.
    await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 200_000 } as any,
        contextEngines: registryWith(engine),
        session: sessionMock,
      },
      messagesOfSize(700_000),
      '',
      personality,
      meta,
    );
    expect(engine.compactCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Item 7 — absolute compaction ceiling (`compaction.maxContextTokens`)
// ---------------------------------------------------------------------------

describe('Item 7 — absolute-token compaction ceiling', () => {
  it('fires on a 1M-window session that the fractional gate alone would let grow', async () => {
    const engine = createSpyEngine();
    // 1M window, no output reserve → fractional gate = 0.8 * 1M = 800k tokens.
    // ~1.6M chars → 400k char/4 tokens = 40% pressure: the fractional gate does
    // NOT fire. The 300k ceiling does.
    const result = await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 1_000_000 } as any,
        contextEngines: registryWith(engine),
        session: sessionMock,
        reservedOutputTokens: 0,
        maxContextTokens: 300_000,
      },
      messagesOfSize(1_600_000),
      '',
      personality,
      meta,
    );
    expect(engine.compactCalled).toBe(true);
    expect(result.messages.length).toBe(2);
  });

  it('leaves the same session alone when no ceiling is configured', async () => {
    const engine = createSpyEngine();
    await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 1_000_000 } as any,
        contextEngines: registryWith(engine),
        session: sessionMock,
        reservedOutputTokens: 0,
      },
      messagesOfSize(1_600_000),
      '',
      personality,
      meta,
    );
    expect(engine.compactCalled).toBe(false);
  });

  it('does not double-compact a small-window model whose fractional gate is lower', async () => {
    const engine = createSpyEngine();
    // 200k window → fractional gate 160k tokens. A 400k ceiling is far above it,
    // so the ceiling must not lower (or raise) anything: 120k tokens of history
    // is under the fractional gate and must stay uncompacted.
    await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 200_000 } as any,
        contextEngines: registryWith(engine),
        session: sessionMock,
        reservedOutputTokens: 0,
        maxContextTokens: 400_000,
      },
      messagesOfSize(480_000),
      '',
      personality,
      meta,
    );
    expect(engine.compactCalled).toBe(false);
  });

  it('keeps the fractional gate when it is the LOWER of the two', async () => {
    const engine = createSpyEngine();
    // 200k window → fractional gate 160k. Ceiling 400k. 175k tokens of history
    // exceeds the fractional gate but not the ceiling → still compacts.
    await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 200_000 } as any,
        contextEngines: registryWith(engine),
        session: sessionMock,
        reservedOutputTokens: 0,
        maxContextTokens: 400_000,
      },
      messagesOfSize(700_000),
      '',
      personality,
      meta,
    );
    expect(engine.compactCalled).toBe(true);
  });

  it('caps the shrink target at the ceiling so the next turn does not re-trip', async () => {
    let seenTarget = -1;
    const engine = {
      name: 'target_spy',
      async compact(opts: ContextEngineCompactInput) {
        seenTarget = opts.targetTokens;
        return { messages: opts.messages.slice(-1), notes: 'x' };
      },
    };
    const registry = new DefaultContextEngineRegistry();
    registry.register(engine);
    await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 1_000_000 } as any,
        contextEngines: registry,
        session: sessionMock,
        reservedOutputTokens: 0,
        maxContextTokens: 300_000,
      },
      messagesOfSize(1_600_000),
      '',
      { ...personality, context_engine: 'target_spy' },
      meta,
    );
    // 0.7 * 300k, not 0.7 * 1M.
    expect(seenTarget).toBe(210_000);
  });

  it('ignores a non-positive ceiling', async () => {
    const engine = createSpyEngine();
    await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: 1_000_000 } as any,
        contextEngines: registryWith(engine),
        session: sessionMock,
        reservedOutputTokens: 0,
        maxContextTokens: 0,
      },
      messagesOfSize(1_600_000),
      '',
      personality,
      meta,
    );
    expect(engine.compactCalled).toBe(false);
  });
});
