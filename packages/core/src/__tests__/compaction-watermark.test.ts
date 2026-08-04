// Phase 2 — compaction watermark read-back + manual /compact.
//
// Covers: the watermark is persisted and REPLAYED on the next turn (so the
// LLM sees `summary + tail`, never the raw prefix again — this is what makes
// the cooldown ship the compacted view); `/compact <focus>` text reaches the
// summarizer; and an unconfigured summarizer degrades to a drop-only compaction.

import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  StoredMessage,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import {
  computeKeptTailBoundary,
  reconstructFromWatermark,
  runManualCompaction,
  selectActiveWatermark,
} from '../agent-loop/manual-compact';
import type { SummarizerFn } from '../context-engines/semantic-summary';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import { createTestSafety } from './helpers/test-safety';

function row(over: Partial<StoredMessage> & { id: string; role: StoredMessage['role'] }) {
  return {
    sessionId: 's',
    content: '',
    timestamp: new Date(),
    ...over,
  } as StoredMessage;
}

describe('watermark helpers', () => {
  it('selectActiveWatermark picks the latest row carrying a boundary', () => {
    const base = {
      originalCount: 0,
      keptCount: 0,
      summaryTokens: 0,
      preTotalTokens: 0,
      postTotalTokens: 0,
      durationMs: 0,
      engineName: 'x',
    };
    const rows = [
      {
        ...base,
        id: 'a',
        sessionId: 's',
        createdAt: new Date(1),
        keptFromMessageId: 'm1',
        summaryText: 'S1',
      },
      { ...base, id: 'b', sessionId: 's', createdAt: new Date(2) }, // no boundary
      {
        ...base,
        id: 'c',
        sessionId: 's',
        createdAt: new Date(3),
        keptFromMessageId: 'm2',
        summaryText: 'S2',
      },
    ];
    expect(selectActiveWatermark(rows)?.id).toBe('c');
    expect(selectActiveWatermark([])).toBeNull();
  });

  it('computeKeptTailBoundary never starts the tail on a tool_result', () => {
    const history = [
      row({ id: '0', role: 'user' }),
      row({ id: '1', role: 'assistant' }),
      row({ id: '2', role: 'assistant' }), // tool_use owner
      row({ id: '3', role: 'tool_result' }),
      row({ id: '4', role: 'tool_result' }),
    ];
    // tailKeep 2 → index 3 is a tool_result → walk back to its assistant (2).
    // Item 7: the user-tail guarantee is switched off (0) so the pair invariant
    // is asserted in isolation; the two composed are covered further down.
    const { index, keptFromMessageId } = computeKeptTailBoundary(history, 2, 0);
    expect(index).toBe(2);
    expect(keptFromMessageId).toBe('2');
  });

  it('walks back over MULTIPLE consecutive tool_result rows (depth > 1)', () => {
    const history = [
      row({ id: '0', role: 'user' }),
      row({ id: '1', role: 'assistant' }), // tool_use owner
      row({ id: '2', role: 'tool_result' }),
      row({ id: '3', role: 'tool_result' }),
    ];
    // tailKeep 1 → index 3 (tool_result) → walk back past index 2 (tool_result)
    // to the owning assistant at index 1. Exercises the multi-step walk-back.
    // Item 7: user-tail guarantee off (0) — see the note above.
    const { index, keptFromMessageId } = computeKeptTailBoundary(history, 1, 0);
    expect(index).toBe(1);
    expect(keptFromMessageId).toBe('1');
  });

  it('reconstructFromWatermark replaces the prefix with the summary and keeps the tail', () => {
    const history = [
      row({ id: '0', role: 'user', content: 'OLD-0' }),
      row({ id: '1', role: 'assistant', content: 'OLD-1' }),
      row({ id: '2', role: 'user', content: 'KEEP-2' }),
      row({ id: '3', role: 'assistant', content: 'KEEP-3' }),
    ];
    const wm = {
      id: 'w1',
      sessionId: 's',
      createdAt: new Date(),
      engineName: 'semantic_summary',
      originalCount: 4,
      keptCount: 3,
      summaryText: 'THE SUMMARY',
      keptFromMessageId: '2',
      summaryTokens: 3,
      preTotalTokens: 0,
      postTotalTokens: 0,
      durationMs: 0,
    };
    const { history: out, applied } = reconstructFromWatermark(history, wm);
    expect(applied).toBe(true);
    expect(out).toHaveLength(3); // summary + KEEP-2 + KEEP-3
    expect(out[0]?.content).toContain('THE SUMMARY');
    expect(out.map((m) => m.content)).not.toContain('OLD-0');
    expect(out.map((m) => m.content)).toContain('KEEP-2');
  });

  it('reconstructFromWatermark drops the prefix (no summary) for drop-only watermarks', () => {
    const history = [
      row({ id: '0', role: 'user', content: 'OLD' }),
      row({ id: '1', role: 'user', content: 'KEEP' }),
    ];
    const wm = {
      id: 'w',
      sessionId: 's',
      createdAt: new Date(),
      engineName: 'drop_oldest',
      originalCount: 2,
      keptCount: 1,
      keptFromMessageId: '1',
      summaryTokens: 0,
      preTotalTokens: 0,
      postTotalTokens: 0,
      durationMs: 0,
    };
    const { history: out } = reconstructFromWatermark(history, wm);
    expect(out.map((m) => m.content)).toEqual(['KEEP']);
  });
});

describe('runManualCompaction', () => {
  function history(n: number): StoredMessage[] {
    return Array.from({ length: n }, (_, i) =>
      row({ id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: `MSG-${i}` }),
    );
  }

  it('threads /compact focus text into the summarizer', async () => {
    const seen: { instructions?: string } = {};
    const summarizer: SummarizerFn = async (_m, _t, instructions) => {
      seen.instructions = instructions;
      return 'summary';
    };
    const session = new InMemorySessionStore();
    const s = await session.createSession({
      key: 'k',
      platform: 'cli',
      model: 'm',
      provider: 'p',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
        apiCallCount: 0,
        compactionCount: 0,
      },
    });
    const res = await runManualCompaction(
      { session, summarizer },
      {
        sessionId: s.id,
        history: history(20),
        engineName: 'semantic_summary',
        instructions: 'the deploy bug',
        tailKeep: 6,
        summaryTargetTokens: 800,
      },
    );
    expect(res.ok).toBe(true);
    expect(seen.instructions).toBe('the deploy bug');
    expect(res.engineName).toBe('semantic_summary');
    // A watermark row was persisted with a boundary + summary.
    const wm = selectActiveWatermark(await session.listCompressions(s.id));
    expect(wm?.summaryText).toBe('summary');
    expect(wm?.keptFromMessageId).toBeTruthy();
  });

  it('degrades to drop_oldest with no hint-enabling summarizer', async () => {
    const session = new InMemorySessionStore();
    const s = await session.createSession({
      key: 'k',
      platform: 'cli',
      model: 'm',
      provider: 'p',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
        apiCallCount: 0,
        compactionCount: 0,
      },
    });
    const res = await runManualCompaction(
      { session },
      {
        sessionId: s.id,
        history: history(20),
        engineName: 'drop_oldest',
        tailKeep: 6,
        summaryTargetTokens: 800,
      },
    );
    expect(res.ok).toBe(true);
    expect(res.summariesEnabled).toBe(false);
    expect(res.engineName).toBe('drop_oldest');
    const wm = selectActiveWatermark(await session.listCompressions(s.id));
    expect(wm?.summaryText).toBeUndefined();
    expect(wm?.keptFromMessageId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: /compact persists a watermark, and the NEXT turn assembles from
// it (not raw history).
// ---------------------------------------------------------------------------

function capturingLLM(captured: Message[][]): LLMProvider {
  return {
    name: 'capture',
    model: 'mock',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      m: Message[],
      _t: unknown,
      _o: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      captured.push(m);
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _e of gen) void _e;
}

function makeLoop(session: InMemorySessionStore, captured: Message[][], summarizer?: SummarizerFn) {
  const personalities = new DefaultPersonalityRegistry();
  vi.spyOn(personalities, 'getDefault').mockReturnValue({ id: 'lean', name: 'Lean', toolset: [] });
  return new AgentLoop({
    llm: capturingLLM(captured),
    session,
    personalities,
    safety: createTestSafety(),
    // Production wires the manual-compact summarizer via the context-engine
    // LLM handle; mirror that here.
    ...(summarizer ? { llmHandle: { summarize: summarizer } } : {}),
  });
}

describe('/compact watermark end-to-end', () => {
  it('turn N+1 assembles from the persisted compaction, not raw history', async () => {
    const session = new InMemorySessionStore();
    const s = await session.createSession({
      key: 'cli:test',
      platform: 'cli',
      model: 'm',
      provider: 'p',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
        apiCallCount: 0,
        compactionCount: 0,
      },
    });
    for (let i = 0; i < 20; i++) {
      await session.appendMessage({
        sessionId: s.id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `OLD-${i}`,
      });
    }

    const captured: Message[][] = [];
    const summarizer: SummarizerFn = async () => 'CONDENSED-SUMMARY';
    const loop = makeLoop(session, captured, summarizer);

    const result = await loop.compact('cli:test');
    expect(result.ok).toBe(true);
    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.preTotalTokens).toBeGreaterThan(result.postTotalTokens);

    await drain(loop.run('a brand new question', { sessionKey: 'cli:test' }));

    expect(captured).toHaveLength(1);
    const sent = JSON.stringify(captured[0]);
    // The condensed summary is present; the oldest raw prefix is gone.
    expect(sent).toContain('CONDENSED-SUMMARY');
    expect(sent).not.toContain('OLD-0"');
    expect(sent).not.toContain('OLD-1"');
    // The freshest turn survived verbatim.
    expect(sent).toContain('a brand new question');
  });

  it('a cooldown turn (no new compaction) still ships the compacted view', async () => {
    const session = new InMemorySessionStore();
    const s = await session.createSession({
      key: 'cli:cool',
      platform: 'cli',
      model: 'm',
      provider: 'p',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
        apiCallCount: 0,
        compactionCount: 0,
      },
    });
    for (let i = 0; i < 16; i++) {
      await session.appendMessage({
        sessionId: s.id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `RAW-${i}`,
      });
    }
    const captured: Message[][] = [];
    const loop = makeLoop(session, captured, async () => 'SUM');
    await loop.compact('cli:cool');

    // Two consecutive normal turns — both under the cooldown, both must replay
    // the persisted compaction rather than the raw prefix.
    await drain(loop.run('q1', { sessionKey: 'cli:cool' }));
    await drain(loop.run('q2', { sessionKey: 'cli:cool' }));

    for (const sent of captured.map((c) => JSON.stringify(c))) {
      expect(sent).toContain('SUM');
      expect(sent).not.toContain('RAW-0"');
    }
  });
});

// ---------------------------------------------------------------------------
// Item 7 — guaranteed N-user-message tail. Lands in `computeKeptTailBoundary`,
// which is the ONLY thing all three compaction paths share (pre-LLM pressure
// gate, turn-end auto-compaction, `/compact`), so all three are asserted.
// ---------------------------------------------------------------------------

/**
 * 20 rows: an alternating user/assistant prefix (users at 0,2,4,6,8,10) followed
 * by a tool-heavy tail (indices 12-19) that contains ZERO user messages — the
 * exact shape where a 6-message tail keeps no record of what was asked.
 */
function toolHeavyHistory(): StoredMessage[] {
  const rows: StoredMessage[] = [];
  for (let i = 0; i < 12; i++) {
    rows.push(
      row({
        id: `m${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: i % 2 === 0 ? `U-${i / 2}` : `A-${(i - 1) / 2}`,
      }),
    );
  }
  const tail: Array<StoredMessage['role']> = [
    'assistant',
    'tool_result',
    'assistant',
    'tool_result',
    'assistant',
    'tool_result',
    'assistant',
    'assistant',
  ];
  tail.forEach((role, i) => {
    rows.push(row({ id: `m${12 + i}`, role, content: `T-${i}` }));
  });
  return rows;
}

describe('Item 7 — computeKeptTailBoundary guarantees N user messages', () => {
  it('widens a tool-heavy tail that would otherwise contain zero user messages', () => {
    const history = toolHeavyHistory();
    // tailKeep 6 alone → index 14, which holds no user message at all.
    expect(computeKeptTailBoundary(history, 6, 0).index).toBe(14);
    const { index, keptFromMessageId } = computeKeptTailBoundary(history, 6, 3);
    // Walks back to the 3rd-newest user message (index 6 = "U-3").
    expect(index).toBe(6);
    expect(keptFromMessageId).toBe('m6');
    const kept = history.slice(index);
    expect(kept.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      'U-3',
      'U-4',
      'U-5',
    ]);
  });

  it('defaults to 3 user messages when no override is passed', () => {
    expect(computeKeptTailBoundary(toolHeavyHistory(), 6).index).toBe(6);
  });

  it('leaves the boundary alone when the tail already holds N user messages', () => {
    const history = Array.from({ length: 20 }, (_, i) =>
      row({ id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant' }),
    );
    // Newest 6 rows (14-19) already contain 3 user messages → no widening.
    expect(computeKeptTailBoundary(history, 6, 3).index).toBe(14);
  });

  it('stops at the start of history when fewer than N user messages exist', () => {
    const history = [
      row({ id: '0', role: 'user' }),
      row({ id: '1', role: 'assistant' }),
      row({ id: '2', role: 'assistant' }),
      row({ id: '3', role: 'assistant' }),
    ];
    const { index, keptFromMessageId } = computeKeptTailBoundary(history, 1, 3);
    expect(index).toBe(0);
    expect(keptFromMessageId).toBe('0');
  });

  it('still never starts the tail on a tool_result (invariant composes)', () => {
    const history = [
      row({ id: '0', role: 'user' }),
      row({ id: '1', role: 'user' }),
      row({ id: '2', role: 'assistant' }), // tool_use owner
      row({ id: '3', role: 'tool_result' }),
      row({ id: '4', role: 'tool_result' }),
      row({ id: '5', role: 'user' }),
      row({ id: '6', role: 'user' }),
      row({ id: '7', role: 'assistant' }), // tool_use owner
      row({ id: '8', role: 'tool_result' }),
    ];
    // tailKeep 5 → index 4 (a tool_result) and the tail already holds 2 users;
    // widening to 3 lands on the user at 1... but the FINAL walk-back over
    // tool_results must still leave the boundary off a tool_result.
    for (const n of [0, 1, 2, 3, 4]) {
      const { index } = computeKeptTailBoundary(history, 5, n);
      expect(history[index]?.role).not.toBe('tool_result');
    }
    // And the widened boundary really does carry 3 user messages forward.
    const { index } = computeKeptTailBoundary(history, 5, 3);
    expect(history.slice(index).filter((m) => m.role === 'user')).toHaveLength(3);
  });
});

describe('Item 7 — the user tail survives on all three compaction paths', () => {
  const NEWEST_USERS = ['U-3', 'U-4', 'U-5'];
  const DROPPED_USERS = ['U-0', 'U-1', 'U-2'];

  async function seedToolHeavySession(session: InMemorySessionStore, key: string) {
    const s = await session.createSession({
      key,
      platform: 'cli',
      model: 'm',
      provider: 'p',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
        apiCallCount: 0,
        compactionCount: 0,
      },
    });
    for (const m of toolHeavyHistory()) {
      await session.appendMessage({ sessionId: s.id, role: m.role, content: m.content });
    }
    return s;
  }

  /** The stored ids of the newest three user messages, in order. */
  async function newestUserIds(session: InMemorySessionStore, sessionId: string) {
    const stored = await session.getMessages(sessionId);
    return stored.filter((m) => NEWEST_USERS.includes(m.content)).map((m) => m.id);
  }

  it('path 3 — /compact keeps the newest 3 user messages verbatim', async () => {
    const session = new InMemorySessionStore();
    const s = await seedToolHeavySession(session, 'cli:tail-manual');
    const captured: Message[][] = [];
    const loop = makeLoop(session, captured, async () => 'SUM');

    const res = await loop.compact('cli:tail-manual');
    expect(res.ok).toBe(true);
    expect(res.droppedCount).toBe(6);
    const wm = selectActiveWatermark(await session.listCompressions(s.id));
    expect(wm?.keptFromMessageId).toBe((await newestUserIds(session, s.id))[0]);

    await drain(loop.run('next question', { sessionKey: 'cli:tail-manual' }));
    const sent = JSON.stringify(captured[0]);
    for (const u of NEWEST_USERS) expect(sent).toContain(u);
    for (const u of DROPPED_USERS) expect(sent).not.toContain(u);
  });

  it('path 2 — turn-end auto-compaction keeps the newest 3 user messages verbatim', async () => {
    const session = new InMemorySessionStore();
    const s = await seedToolHeavySession(session, 'cli:tail-turnend');
    const captured: Message[][] = [];
    const loop = new AgentLoop({
      llm: capturingLLM(captured),
      session,
      safety: createTestSafety(),
      llmHandle: { summarize: async () => 'SUM' },
      // An absolute ceiling of 1 token forces the turn-end gate open without
      // fabricating a 160k-token history.
      compaction: { maxContextTokens: 1 },
    });

    await drain(loop.run('next question', { sessionKey: 'cli:tail-turnend' }));
    const wm = selectActiveWatermark(await session.listCompressions(s.id));
    // The turn-end path compacts the replay history INCLUDING this turn's own
    // user message, so the newest three users shift — assert on content.
    expect(wm?.keptFromMessageId).toBeTruthy();
    const stored = await session.getMessages(s.id);
    const boundaryIdx = stored.findIndex((m) => m.id === wm?.keptFromMessageId);
    expect(boundaryIdx).toBeGreaterThan(0);
    expect(
      stored.slice(boundaryIdx).filter((m) => m.role === 'user').length,
    ).toBeGreaterThanOrEqual(3);
    expect(stored.slice(0, boundaryIdx).map((m) => m.content)).toContain('U-0');
  });

  it('path 1 — the pre-LLM pressure gate persists a boundary with 3 user messages', async () => {
    const session = new InMemorySessionStore();
    const s = await seedToolHeavySession(session, 'cli:tail-pregate');
    const captured: Message[][] = [];
    const personalities = new DefaultPersonalityRegistry();
    vi.spyOn(personalities, 'getDefault').mockReturnValue({
      id: 'lean',
      name: 'Lean',
      toolset: [],
      context_engine: 'semantic_summary',
    });
    const loop = new AgentLoop({
      llm: capturingLLM(captured),
      session,
      personalities,
      safety: createTestSafety(),
      llmHandle: { summarize: async () => 'PRE-GATE-SUM' },
      // Ceiling of 1 token → the PRE-LLM gate fires during this turn's assembly.
      compaction: { maxContextTokens: 1, autoCompact: false },
    });

    await drain(loop.run('pre-gate question', { sessionKey: 'cli:tail-pregate' }));
    // This turn's own user message is part of the replay history, so the three
    // guaranteed users are U-4, U-5 and "pre-gate question" — the boundary lands
    // on U-4 (the second of the three seeded newest users).
    const wm = selectActiveWatermark(await session.listCompressions(s.id));
    expect(wm?.keptFromMessageId).toBe((await newestUserIds(session, s.id))[1]);

    // The NEXT turn replays from that boundary: those users verbatim, nothing
    // older.
    await drain(loop.run('follow-up', { sessionKey: 'cli:tail-pregate' }));
    const sent = JSON.stringify(captured[1]);
    for (const u of ['U-4', 'U-5', 'pre-gate question']) expect(sent).toContain(u);
    for (const u of [...DROPPED_USERS, 'U-3']) expect(sent).not.toContain(u);
  });
});
