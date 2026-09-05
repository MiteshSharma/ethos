// Ground-truth verification, T2 — the Layer 2 seam.
//
// R5's whole point is ORDERING: `done` closes the turn, so a finding yielded
// after it reaches no surface. Every assertion below is therefore about
// position in the event stream, not just presence. The rest is the fail-open
// contract — a throwing or hanging auditor must cost the turn nothing.

import type {
  AfterToolCallPayload,
  AgentEvent,
  CompletionChunk,
  LLMProvider,
  ToolResult,
  TurnAuditContext,
  TurnAuditor,
  TurnFinding,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import { DefaultHookRegistry } from '../hook-registry';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

/** The seam's budget is 250ms; a hang must sit far enough past it that a
 *  loaded box cannot make the test lie in either direction. */
const HANG_MS = 5_000;
const BUDGET_CEILING_MS = 3_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One plain text turn, no tools. */
function textLLM(): LLMProvider {
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      yield { type: 'text_delta', text: 'I ran the tests and they pass.' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

/** One tool round, then a plain finish — for the `after_tool_call` payload. */
function oneToolLLM(): LLMProvider {
  let calls = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      calls++;
      if (calls === 1) {
        yield { type: 'tool_use_start', toolCallId: 'call-77', toolName: 'echo' };
        yield { type: 'tool_use_end', toolCallId: 'call-77', inputJson: '{"text":"hi"}' };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function echoTool(): DefaultToolRegistry {
  const tools = new DefaultToolRegistry();
  tools.register({
    name: 'echo',
    description: 'echoes',
    schema: { type: 'object' },
    capabilities: {},
    async execute(): Promise<ToolResult> {
      return { ok: true, value: 'hi' };
    },
  });
  return tools;
}

function warnFinding(over: Partial<TurnFinding> = {}): TurnFinding {
  return {
    code: 'contradicted',
    severity: 'warn',
    message: '"tests pass" — run_tests exited 1',
    claim: 'tests pass',
    ...over,
  };
}

/** An auditor that records the context it was handed and returns `findings`. */
function auditor(
  id: string,
  findings: TurnFinding[],
  seen?: TurnAuditContext[],
  delayMs = 0,
): TurnAuditor {
  return {
    id,
    async audit(ctx) {
      seen?.push(ctx);
      if (delayMs > 0) await sleep(delayMs);
      return findings;
    },
  };
}

async function collect(loop: AgentLoop, sessionKey: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of loop.run('go', { sessionKey })) events.push(e);
  return events;
}

/** Indexes of the `_grounding` progress events and of `done`. */
function positions(events: AgentEvent[]): { grounding: number[]; done: number } {
  const grounding: number[] = [];
  let done = -1;
  events.forEach((e, i) => {
    if (e.type === 'tool_progress' && e.toolName === '_grounding') grounding.push(i);
    if (e.type === 'done') done = i;
  });
  return { grounding, done };
}

describe('turn auditors (ground-truth verification, R5)', () => {
  it('yields each warn finding as a user-audience _grounding line BEFORE done', async () => {
    const loop = new AgentLoop({
      llm: textLLM(),
      personalities: new DefaultPersonalityRegistry(),
      safety: createTestSafety(),
      turnAuditors: [auditor('groundtruth', [warnFinding()])],
    });
    const events = await collect(loop, 'cli:audit-order');

    const { grounding, done } = positions(events);
    expect(grounding).toHaveLength(1);
    expect(done).toBeGreaterThan(-1);
    // The regression this test exists for: a finding yielded after `done`
    // never reaches a surface, because `done` is what closes the turn.
    expect(grounding[0]).toBeLessThan(done);

    const line = events[grounding[0] ?? 0];
    expect(line).toMatchObject({
      type: 'tool_progress',
      toolName: '_grounding',
      audience: 'user',
      message: '"tests pass" — run_tests exited 1',
    });
  });

  it('hands the auditor the session, the final text and the turn tool names', async () => {
    const seen: TurnAuditContext[] = [];
    const loop = new AgentLoop({
      llm: oneToolLLM(),
      tools: echoTool(),
      personalities: new DefaultPersonalityRegistry(),
      safety: createTestSafety(),
      turnAuditors: [auditor('groundtruth', [], seen)],
    });
    await collect(loop, 'cli:audit-ctx');

    expect(seen).toHaveLength(1);
    expect(seen[0]?.sessionId).toBeTruthy();
    expect(seen[0]?.text).toBe('done');
    expect(seen[0]?.toolNames).toEqual(['echo']);
  });

  it('does not surface an info finding, but still records it', async () => {
    const recorded: Array<Record<string, unknown>> = [];
    const loop = new AgentLoop({
      llm: textLLM(),
      personalities: new DefaultPersonalityRegistry(),
      safety: createTestSafety(),
      observability: observabilityRecording(recorded),
      turnAuditors: [
        auditor('groundtruth', [warnFinding({ code: 'unsupported', severity: 'info' })]),
      ],
    });
    const events = await collect(loop, 'cli:audit-info');

    expect(positions(events).grounding).toHaveLength(0);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ code: 'unsupported', severity: 'info' });
  });

  it('swallows a throwing auditor and keeps the other auditors findings', async () => {
    const thrower: TurnAuditor = {
      id: 'boom',
      async audit() {
        throw new Error('auditor exploded');
      },
    };
    const loop = new AgentLoop({
      llm: textLLM(),
      personalities: new DefaultPersonalityRegistry(),
      safety: createTestSafety(),
      turnAuditors: [thrower, auditor('groundtruth', [warnFinding()])],
    });
    const events = await collect(loop, 'cli:audit-throw');

    const { grounding, done } = positions(events);
    expect(done).toBeGreaterThan(-1);
    expect(grounding).toHaveLength(1);
    expect(grounding[0]).toBeLessThan(done);
  });

  it('swallows an auditor that throws SYNCHRONOUSLY and still yields done', async () => {
    // `audit` is not required to be `async`. A non-async method that throws
    // does so while the race array is still being built — before
    // `Promise.allSettled` exists to settle anything — so an implementation
    // that called `audit` directly in the `map` would let the exception escape
    // `finalizeTurn` and end the turn with NO `done` event. The existing
    // throwing-auditor test cannot catch that: its `audit` is `async`, so its
    // throw is already a rejected promise.
    const syncThrower: TurnAuditor = {
      id: 'sync-boom',
      audit(): Promise<TurnFinding[]> {
        throw new Error('threw before returning a promise');
      },
    };
    const loop = new AgentLoop({
      llm: textLLM(),
      personalities: new DefaultPersonalityRegistry(),
      safety: createTestSafety(),
      turnAuditors: [syncThrower, auditor('groundtruth', [warnFinding()])],
    });
    const events = await collect(loop, 'cli:audit-sync-throw');

    const { grounding, done } = positions(events);
    expect(done).toBeGreaterThan(-1);
    expect(events.at(-1)?.type).toBe('done');
    // The healthy auditor's finding still arrives, still before `done`.
    expect(grounding).toHaveLength(1);
    expect(grounding[0]).toBeLessThan(done);
  });

  it('cuts a hanging auditor at the budget and still completes the turn', async () => {
    const hanger = auditor('slow', [warnFinding({ message: 'too late' })], undefined, HANG_MS);
    const loop = new AgentLoop({
      llm: textLLM(),
      personalities: new DefaultPersonalityRegistry(),
      safety: createTestSafety(),
      turnAuditors: [hanger, auditor('groundtruth', [warnFinding()])],
    });
    const started = Date.now();
    const events = await collect(loop, 'cli:audit-budget');
    const elapsed = Date.now() - started;

    // The budget bounds the TOTAL, so the hang cannot hold the turn open.
    expect(elapsed).toBeLessThan(BUDGET_CEILING_MS);
    const { grounding, done } = positions(events);
    expect(done).toBeGreaterThan(-1);
    // The auditor that finished keeps its finding; the one that hung has none.
    expect(grounding).toHaveLength(1);
    const messages = grounding.map((i) => {
      const e = events[i];
      return e?.type === 'tool_progress' ? e.message : '';
    });
    expect(messages).not.toContain('too late');
  });

  it('records every finding with its auditor id, and is harmless with no observability', async () => {
    const recorded: Array<Record<string, unknown>> = [];
    const withObs = new AgentLoop({
      llm: textLLM(),
      personalities: new DefaultPersonalityRegistry(),
      safety: createTestSafety(),
      observability: observabilityRecording(recorded),
      turnAuditors: [auditor('groundtruth', [warnFinding()])],
    });
    await collect(withObs, 'cli:audit-obs');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      code: 'contradicted',
      severity: 'warn',
      auditorId: 'groundtruth',
      claim: 'tests pass',
    });

    // Same turn, adapter without the optional method — the defensive `?.` is
    // the whole contract, so absence must change nothing the user sees.
    const bare = new AgentLoop({
      llm: textLLM(),
      personalities: new DefaultPersonalityRegistry(),
      safety: createTestSafety(),
      observability: observabilityBare(),
      turnAuditors: [auditor('groundtruth', [warnFinding()])],
    });
    const events = await collect(bare, 'cli:audit-obs-bare');
    expect(positions(events).grounding).toHaveLength(1);
  });

  it('ends the turn unchanged when no auditors are wired', async () => {
    const loop = new AgentLoop({
      llm: textLLM(),
      personalities: new DefaultPersonalityRegistry(),
      safety: createTestSafety(),
    });
    const events = await collect(loop, 'cli:audit-none');
    expect(positions(events).grounding).toHaveLength(0);
    expect(events.at(-1)?.type).toBe('done');
  });
});

describe('after_tool_call payload (evidence, Layer 1)', () => {
  it('carries the call id, the effective args, the personality and the working dir', async () => {
    const payloads: AfterToolCallPayload[] = [];
    const hooks = new DefaultHookRegistry();
    hooks.registerVoid('after_tool_call', async (payload: AfterToolCallPayload) => {
      payloads.push(payload);
    });
    const personalities = new DefaultPersonalityRegistry();
    vi.spyOn(personalities, 'getDefault').mockReturnValue({
      id: 'auditee',
      name: 'Auditee',
    });

    const loop = new AgentLoop({
      llm: oneToolLLM(),
      tools: echoTool(),
      hooks,
      personalities,
      safety: createTestSafety(),
      options: { workingDir: '/tmp/ethos-audit-wd' },
    });
    await collect(loop, 'cli:audit-payload');

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      toolCallId: 'call-77',
      toolName: 'echo',
      args: { text: 'hi' },
      personalityId: 'auditee',
      workingDir: '/tmp/ethos-audit-wd',
    });
  });
});

/** Minimal adapter that captures `recordGroundingFinding` calls. */
function observabilityRecording(into: Array<Record<string, unknown>>): AgentLoopObservability {
  return {
    ...observabilityBare(),
    recordGroundingFinding: (opts) => {
      into.push({ ...opts });
    },
  };
}

/** Minimal adapter WITHOUT the optional method. */
function observabilityBare(): AgentLoopObservability {
  return {
    startTurnTrace: () => 'trace-1',
    endTrace: () => {},
    startSpan: () => 'span-1',
    endSpan: () => {},
    recordSafetyBlock: () => {},
    recordCompaction: () => {},
    recordTierEscalation: () => {},
    recordTierOverride: () => {},
    flush: () => {},
  };
}
