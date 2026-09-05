// Ground-truth verification wiring (plan/phases/ground-truth-verification.md,
// T4). The seam that hands `@ethosagent/safety-groundtruth` its injected ports
// and turns `grounding.*` config into hooks, an auditor, and — in `correct`
// mode — a one-shot context injector.

import { AgentLoop, DefaultHookRegistry, DefaultPersonalityRegistry } from '@ethosagent/core';
import { MemoryCaptureRunner } from '@ethosagent/memory-capture';
import { HistoryStore } from '@ethosagent/memory-history';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { GROUNDING_TOOL_NAME } from '@ethosagent/safety-groundtruth';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  AfterToolCallPayload,
  AgentDonePayload,
  AgentEvent,
  CompletionChunk,
  LLMProvider,
  Logger,
  MemoryContext,
  PromptContext,
  Session,
  SessionStore,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { composeGrounding, type GroundingConfig } from '../grounding';
import { createTestSafety } from './helpers/wiring-test-safety';

function compose(config?: GroundingConfig, pidAlive: (pid: number) => boolean = () => true) {
  const hooks = new DefaultHookRegistry();
  const result = composeGrounding({ ...(config ? { config } : {}), hooks, pidAlive });
  return { hooks, ...result };
}

function toolCall(overrides: Partial<AfterToolCallPayload> = {}): AfterToolCallPayload {
  const ok: ToolResult = { ok: true, value: 'done', structured: { exitCode: 0, command: 'ls' } };
  return {
    sessionId: 's1',
    toolCallId: 'tc-1',
    toolName: 'terminal',
    args: {},
    result: ok,
    workingDir: '/tmp',
    durationMs: 12,
    ...overrides,
  };
}

function promptCtx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    sessionId: 's1',
    sessionKey: 'sk1',
    platform: 'cli',
    model: 'test-model',
    history: [],
    isDm: true,
    turnNumber: 4,
    ...overrides,
  };
}

describe('composeGrounding — registration', () => {
  it('registers the collector and the ledger reset, and returns the auditor, by default', async () => {
    const { hooks, turnAuditors, injectors } = compose();

    expect(turnAuditors).toHaveLength(1);
    expect(turnAuditors[0]?.id).toBe('grounding-claims');
    // `annotate` is the default outcome — no injector until `correct` asks.
    expect(injectors).toEqual([]);

    // Both hooks are live: the collector fills the ledger, the reset empties it.
    await hooks.fireVoid('after_tool_call', toolCall());
    await hooks.fireVoid('session_start', {
      sessionId: 's1',
      sessionKey: 'sk1',
      platform: 'cli',
      personalityId: 'researcher',
    });
  });

  it('registers nothing when grounding.enabled is false', () => {
    const hooks = new DefaultHookRegistry();
    const registerVoid = vi.spyOn(hooks, 'registerVoid');

    const off = composeGrounding({ config: { enabled: false }, hooks, pidAlive: () => true });

    expect(registerVoid).not.toHaveBeenCalled();
    expect(off.turnAuditors).toEqual([]);
    expect(off.injectors).toEqual([]);

    // ...and the same registry, left on, registers exactly the two.
    const on = composeGrounding({ hooks, pidAlive: () => true });
    expect(registerVoid.mock.calls.map((c) => c[0])).toEqual(['after_tool_call', 'session_start']);
    expect(on.turnAuditors).toHaveLength(1);
  });

  it('the collector receives after_tool_call and the auditor reads what it recorded', async () => {
    const { hooks, turnAuditors } = compose();
    const auditor = turnAuditors[0];
    expect(auditor).toBeDefined();
    if (!auditor) return;

    // A test command that FAILED. The reply then claims tests pass.
    await hooks.fireVoid(
      'after_tool_call',
      toolCall({
        toolCallId: 'tc-tests',
        toolName: 'run_tests',
        result: { ok: false, error: 'exit 1', code: 'execution_failed' },
      }),
    );

    const findings = await auditor.audit({
      sessionId: 's1',
      text: 'I ran the suite and all tests pass.',
      toolNames: ['run_tests'],
    });

    expect(findings.map((f) => f.code)).toContain('contradicted');
    expect(findings[0]?.evidenceRef).toBe('tc-tests');
  });

  it('the ledger resets per turn — session_start clears the previous turn evidence', async () => {
    const { hooks, turnAuditors } = compose();
    const auditor = turnAuditors[0];
    if (!auditor) throw new Error('auditor missing');

    await hooks.fireVoid(
      'after_tool_call',
      toolCall({
        toolCallId: 'tc-tests',
        toolName: 'run_tests',
        result: { ok: false, error: 'exit 1', code: 'execution_failed' },
      }),
    );
    // `session_start` fires at the top of every turn, so this IS the next turn.
    await hooks.fireVoid('session_start', { sessionId: 's1', sessionKey: 'sk1', platform: 'cli' });

    const findings = await auditor.audit({
      sessionId: 's1',
      text: 'I ran the suite and all tests pass.',
      toolNames: ['run_tests'],
    });

    // Last turn's failure is gone, so this can no longer be CONTRADICTED —
    // at most unsupported, which is the gated verdict.
    expect(findings.map((f) => f.code)).not.toContain('contradicted');
  });

  it('passes pidAlive through as the injected port', async () => {
    const asked: number[] = [];
    const { hooks, turnAuditors } = compose(undefined, (pid) => {
      asked.push(pid);
      return false;
    });
    const auditor = turnAuditors[0];
    if (!auditor) throw new Error('auditor missing');

    await hooks.fireVoid(
      'after_tool_call',
      toolCall({
        toolCallId: 'tc-proc',
        toolName: 'process_start',
        result: { ok: true, value: 'started', structured: { id: 'p1', pid: 4242 } },
      }),
    );

    expect(asked).toEqual([4242]);
    const findings = await auditor.audit({
      sessionId: 's1',
      text: 'I started the dev server in the background.',
      toolNames: ['process_start'],
    });
    // The probe said the pid was already gone, so the claim is contradicted.
    expect(findings.map((f) => f.code)).toContain('contradicted');
  });

  it('supplies the sentence splitter as the other injected port', async () => {
    const { turnAuditors } = compose();
    const auditor = turnAuditors[0];
    if (!auditor) throw new Error('auditor missing');

    // Two claims on ONE line. `@ethosagent/safety-groundtruth` cannot import
    // `@ethosagent/voice-text` — security-kernel depends on contracts and
    // nothing else — so without this seam the line is read as a single
    // sentence and the second claim is never seen.
    const findings = await auditor.audit({
      sessionId: 's1',
      text: 'I wrote src/a.ts. I committed the change.',
      toolNames: [],
    });

    expect(findings.map((f) => f.claim)).toEqual(['I wrote src/a.ts.', 'I committed the change.']);
  });

  it('showUnsupported promotes the gated verdict to a user-visible one', async () => {
    const quiet = compose();
    const loud = compose({ showUnsupported: true });
    const ctx = {
      sessionId: 's1',
      text: 'I wrote the report to report.md.',
      toolNames: ['terminal'],
    };

    const quietFindings = (await quiet.turnAuditors[0]?.audit(ctx)) ?? [];
    const loudFindings = (await loud.turnAuditors[0]?.audit(ctx)) ?? [];

    expect(quietFindings[0]?.severity).toBe('info');
    expect(loudFindings[0]?.severity).toBe('warn');
  });
});

describe('composeGrounding — correct mode', () => {
  const correct: GroundingConfig = { onFinding: 'correct' };

  async function auditOneFailedTurn(bundle: ReturnType<typeof compose>): Promise<void> {
    await bundle.hooks.fireVoid(
      'after_tool_call',
      bundleFailure({
        toolCallId: 'tc-tests',
        toolName: 'run_tests',
      }),
    );
    await bundle.turnAuditors[0]?.audit({
      sessionId: 's1',
      text: 'I ran the suite and all tests pass.',
      toolNames: ['run_tests'],
    });
  }

  function bundleFailure(overrides: Partial<AfterToolCallPayload>): AfterToolCallPayload {
    return toolCall({
      result: { ok: false, error: 'exit 1', code: 'execution_failed' },
      ...overrides,
    });
  }

  it('adds the grounding-correction injector only in correct mode', () => {
    expect(compose({ onFinding: 'annotate' }).injectors).toEqual([]);
    const injectors = compose(correct).injectors;
    expect(injectors).toHaveLength(1);
    expect(injectors[0]?.id).toBe('grounding-correction');
  });

  it('appends — never prepends — so the static prompt prefix stays byte-identical', async () => {
    const bundle = compose(correct);
    await auditOneFailedTurn(bundle);

    const injector = bundle.injectors[0];
    if (!injector) throw new Error('injector missing');
    const result = await injector.inject(promptCtx());

    expect(result?.position).toBe('append');
    expect(result?.content).toContain('Correction required');
    expect(result?.content).toContain('tests pass');
  });

  it('injects nothing until a finding is recorded', async () => {
    const bundle = compose(correct);
    const injector = bundle.injectors[0];
    if (!injector) throw new Error('injector missing');

    expect(injector.shouldInject?.(promptCtx())).toBe(false);
    await expect(injector.inject(promptCtx())).resolves.toBeNull();
  });

  it('is one-shot: the same turn re-renders identically, a later turn gets nothing', async () => {
    const bundle = compose(correct);
    await auditOneFailedTurn(bundle);
    const injector = bundle.injectors[0];
    if (!injector) throw new Error('injector missing');

    // Re-assembling the SAME turn must produce the same bytes — a compaction
    // retry that dropped the section would change the prompt mid-turn.
    const first = await injector.inject(promptCtx({ turnNumber: 4 }));
    const again = await injector.inject(promptCtx({ turnNumber: 4 }));
    expect(again?.content).toBe(first?.content);

    // The next turn is a different turnNumber: spent.
    expect(injector.shouldInject?.(promptCtx({ turnNumber: 6 }))).toBe(false);
    await expect(injector.inject(promptCtx({ turnNumber: 6 }))).resolves.toBeNull();
  });

  it('does not correct another session', async () => {
    const bundle = compose(correct);
    await auditOneFailedTurn(bundle);
    const injector = bundle.injectors[0];
    if (!injector) throw new Error('injector missing');

    await expect(injector.inject(promptCtx({ sessionId: 'other' }))).resolves.toBeNull();
  });

  it('leaves the findings the loop surfaces untouched', async () => {
    const bundle = compose(correct);
    await bundle.hooks.fireVoid(
      'after_tool_call',
      bundleFailure({ toolCallId: 'tc-tests', toolName: 'run_tests' }),
    );
    const findings =
      (await bundle.turnAuditors[0]?.audit({
        sessionId: 's1',
        text: 'I ran the suite and all tests pass.',
        toolNames: ['run_tests'],
      })) ?? [];

    expect(findings.map((f) => f.code)).toContain('contradicted');
    expect(bundle.turnAuditors[0]?.id).toBe('grounding-claims');
  });

  it('records only warn findings — an info verdict is too quiet to correct with', async () => {
    const bundle = compose({ onFinding: 'correct' });
    // A turn that ran a write-capable tool: the unmatched claim is `info`.
    await bundle.turnAuditors[0]?.audit({
      sessionId: 's1',
      text: 'I wrote the report to report.md.',
      toolNames: ['terminal'],
    });
    const injector = bundle.injectors[0];
    if (!injector) throw new Error('injector missing');
    expect(injector.shouldInject?.(promptCtx())).toBe(false);
  });
});

describe('the _grounding wire name is what surfaces match on', () => {
  it('is stable', () => {
    expect(GROUNDING_TOOL_NAME).toBe('_grounding');
  });
});

describe('composeGrounding — through a real AgentLoop', () => {
  /** One plain text turn that claims work it did not do, with no tools at all. */
  function fabricatingLLM(): LLMProvider {
    return {
      name: 'scripted',
      model: 'mock-model',
      maxContextTokens: 200_000,
      supportsCaching: false,
      supportsThinking: false,
      async *complete(): AsyncIterable<CompletionChunk> {
        yield { type: 'text_delta', text: 'I ran the test suite and everything passes.' };
        yield { type: 'done', finishReason: 'end_turn' };
      },
      async countTokens() {
        return 1;
      },
    };
  }

  async function runTurn(config?: GroundingConfig): Promise<AgentEvent[]> {
    const hooks = new DefaultHookRegistry();
    const { turnAuditors } = composeGrounding({
      ...(config ? { config } : {}),
      hooks,
      pidAlive: () => true,
    });
    const loop = new AgentLoop({
      llm: fabricatingLLM(),
      hooks,
      personalities: new DefaultPersonalityRegistry(),
      safety: createTestSafety(),
      ...(turnAuditors.length > 0 ? { turnAuditors } : {}),
    });
    const events: AgentEvent[] = [];
    for await (const e of loop.run('go', { sessionKey: `cli:grounding-${Math.random()}` })) {
      events.push(e);
    }
    return events;
  }

  it('the composed auditor reaches the loop and its finding lands before done', async () => {
    const events = await runTurn();

    const groundingAt = events.findIndex(
      (e) => e.type === 'tool_progress' && e.toolName === GROUNDING_TOOL_NAME,
    );
    const doneAt = events.findIndex((e) => e.type === 'done');

    expect(groundingAt).toBeGreaterThan(-1);
    // `done` closes the turn, so a finding after it reaches no surface.
    expect(groundingAt).toBeLessThan(doneAt);
    expect(events[groundingAt]).toMatchObject({
      audience: 'user',
      message: expect.stringContaining('no tools ran this turn'),
    });
  });

  it('says nothing at all when grounding is switched off', async () => {
    const events = await runTurn({ enabled: false });

    expect(
      events.some((e) => e.type === 'tool_progress' && e.toolName === GROUNDING_TOOL_NAME),
    ).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R8 — the memory-capture consult.
//
// `agent_done` fires BEFORE the turn auditors run, so at the moment capture
// enqueues, this turn's findings do not exist and cannot be read back. Wiring
// answers the question instead, by re-running the same deterministic auditor
// over the same per-turn ledger. memory-capture imports nothing from
// `@ethosagent/safety-groundtruth` — the port is injected, so a build without
// the grounding package cannot behave differently.
// ---------------------------------------------------------------------------

const CAPTURE_DATA = '/root/.ethos';
const LONG_PROMPT =
  'My daughter Priya was born in 2019 and I work as a staff engineer at Acme, please remember it.';
const FACT_LINE = 'USER|0.8|Has a daughter named Priya, born 2019.';

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
};

function captureCtx(): MemoryContext {
  return {
    scopeId: 'personality:muse',
    sessionId: 's1',
    sessionKey: 'cli:ethos',
    platform: 'cli',
    workingDir: CAPTURE_DATA,
  };
}

/** A real runner behind the composed consult — the whole point is that the
 *  seam wiring builds is the one capture actually consults. */
function makeCapture(bundle: ReturnType<typeof compose>) {
  const storage = new InMemoryStorage();
  const provider = new MarkdownFileMemoryProvider({ dir: CAPTURE_DATA, storage });
  const history = new HistoryStore({ dataDir: CAPTURE_DATA, storage });
  const llmCalls: string[] = [];
  const llm: LLMProvider = {
    name: 'fake',
    model: 'fake-model',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete() {
      llmCalls.push('called');
      yield { type: 'text_delta', text: FACT_LINE };
    },
    async countTokens() {
      return 0;
    },
  };
  const session: SessionStore = {
    getSession: async (id: string) => ({ id, key: 'cli:ethos' }) as unknown as Session,
  } as unknown as SessionStore;
  const runner = new MemoryCaptureRunner({
    provider,
    history,
    session,
    llm,
    sanitize: (s) => s,
    logger: NOOP_LOGGER,
    nightlyConfigured: false,
    workingDir: CAPTURE_DATA,
    ...(bundle.memoryConsult ? { grounding: bundle.memoryConsult } : {}),
  });
  runner.registerHook(bundle.hooks);
  return { runner, provider, history, llmCalls };
}

/** A failed `run_tests` in the ledger — the evidence a "tests pass" claim
 *  contradicts. */
async function recordFailedTests(hooks: DefaultHookRegistry): Promise<void> {
  await hooks.fireVoid(
    'after_tool_call',
    toolCall({
      toolCallId: 'tc-tests',
      toolName: 'run_tests',
      result: { ok: false, error: 'exit 1', code: 'execution_failed' },
    }),
  );
}

const DONE_PAYLOAD: AgentDonePayload = {
  sessionId: 's1',
  text: 'I ran the suite and all tests pass.',
  turnCount: 1,
  personalityId: 'muse',
  initialPrompt: LONG_PROMPT,
};

describe('composeGrounding — memory-capture consult', () => {
  it('supplies the port when grounding is on, and withholds it entirely when off', () => {
    expect(compose().memoryConsult).toBeDefined();
    expect(compose({ enabled: false }).memoryConsult).toBeUndefined();
  });

  it('carries grounding.memoryTag as the port tag — default false', () => {
    expect(compose().memoryConsult?.tag).toBe(false);
    expect(compose({ memoryTag: false }).memoryConsult?.tag).toBe(false);
    expect(compose({ memoryTag: true }).memoryConsult?.tag).toBe(true);
  });

  it('reports contradicted for a turn whose own evidence says otherwise', async () => {
    const bundle = compose();
    await recordFailedTests(bundle.hooks);

    expect(
      await bundle.memoryConsult?.contradicted({
        sessionId: 's1',
        text: 'I ran the suite and all tests pass.',
      }),
    ).toBe(true);
  });

  it('clears a turn that ran nothing, and a turn whose evidence agrees', async () => {
    // Empty ledger: a contradiction needs a record to contradict against.
    expect(
      await compose().memoryConsult?.contradicted({
        sessionId: 's1',
        text: 'I ran the suite and all tests pass.',
      }),
    ).toBe(false);

    const bundle = compose();
    await bundle.hooks.fireVoid(
      'after_tool_call',
      toolCall({
        toolCallId: 'tc-ok',
        toolName: 'run_tests',
        result: { ok: true, value: 'ok\n(exit 0)', structured: { exitCode: 0, command: 'vitest' } },
      }),
    );
    expect(
      await bundle.memoryConsult?.contradicted({
        sessionId: 's1',
        text: 'I ran the suite and all tests pass.',
      }),
    ).toBe(false);
  });

  it('asking the consult does not queue a correction — only the loop audit does', async () => {
    const bundle = compose({ onFinding: 'correct' });
    await recordFailedTests(bundle.hooks);
    await bundle.memoryConsult?.contradicted({
      sessionId: 's1',
      text: 'I ran the suite and all tests pass.',
    });

    const injector = bundle.injectors[0];
    if (!injector) throw new Error('injector missing');
    expect(injector.shouldInject?.(promptCtx({ turnNumber: 5 }))).toBe(false);
  });

  it('memoryTag off: a contradicted turn is not captured at all', async () => {
    const bundle = compose();
    const cap = makeCapture(bundle);
    await recordFailedTests(bundle.hooks);

    await bundle.hooks.fireVoid('agent_done', DONE_PAYLOAD);
    await cap.runner.whenIdle();

    expect(cap.llmCalls).toHaveLength(0);
    expect(await cap.provider.read('USER.md', captureCtx())).toBeNull();
  });

  it('memoryTag on: the same turn is captured and marked unverified', async () => {
    const bundle = compose({ memoryTag: true });
    const cap = makeCapture(bundle);
    await recordFailedTests(bundle.hooks);

    await bundle.hooks.fireVoid('agent_done', DONE_PAYLOAD);
    await cap.runner.whenIdle();

    const content = (await cap.provider.read('USER.md', captureCtx()))?.content ?? '';
    expect(content).toContain('daughter named Priya');
    expect(content).toContain('(unverified)');
  });

  it('a turn with no contradiction captures exactly as before', async () => {
    const bundle = compose();
    const cap = makeCapture(bundle);
    await bundle.hooks.fireVoid(
      'after_tool_call',
      toolCall({
        toolCallId: 'tc-ok',
        toolName: 'run_tests',
        result: { ok: true, value: 'ok\n(exit 0)', structured: { exitCode: 0, command: 'vitest' } },
      }),
    );

    await bundle.hooks.fireVoid('agent_done', DONE_PAYLOAD);
    await cap.runner.whenIdle();

    const content = (await cap.provider.read('USER.md', captureCtx()))?.content ?? '';
    expect(content).toContain('daughter named Priya');
    expect(content).not.toContain('unverified');
  });
});
