import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgentLoop,
  DefaultHookRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
} from '@ethosagent/core';
import type {
  AgentEvent,
  BeforeToolCallPayload,
  CompletionChunk,
  LLMProvider,
  Message,
  PersonalityConfig,
} from '@ethosagent/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestSafety } from '../../../core/src/__tests__/helpers/test-safety';
import { createApprovalDangerPredicate, createLazyProvider } from '../approval-seams';
import { createSmartApprover } from '../smart-approver';

// The reviewer must not even be CONSTRUCTED on the default path — a
// deployment where no personality declares `smart` pays nothing. Spying on the
// factory is the only way to assert that from outside.
vi.mock('../smart-approver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../smart-approver')>();
  return { ...actual, createSmartApprover: vi.fn(actual.createSmartApprover) };
});

function payload(toolName: string, args: unknown, sessionId = 'sess-1'): BeforeToolCallPayload {
  return { sessionId, toolCallId: 'tc-1', toolName, args };
}

function person(id: string, safety?: PersonalityConfig['safety']): PersonalityConfig {
  return { id, name: id, ...(safety ? { safety } : {}) };
}

function registryWith(...configs: PersonalityConfig[]): DefaultPersonalityRegistry {
  const registry = new DefaultPersonalityRegistry();
  for (const config of configs) registry.define(config);
  return registry;
}

/** Provider that answers every review with the same verdict JSON. */
function verdictProvider(json: string): { provider: LLMProvider; calls: () => number } {
  let calls = 0;
  const provider: LLMProvider = {
    name: 'stub',
    model: 'stub-model',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(_messages: Message[]): AsyncIterable<CompletionChunk> {
      calls++;
      yield { type: 'text_delta', text: json };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
  return { provider, calls: () => calls };
}

/** LLM that calls `toolName` once, then ends the turn with text. */
function toolCallingLLM(toolName: string, args: unknown): LLMProvider {
  let round = 0;
  return {
    name: 'tool-caller',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      round++;
      if (round > 1) {
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      const inputJson = JSON.stringify(args);
      yield { type: 'tool_use_start', toolCallId: 'call-1', toolName };
      yield { type: 'tool_use_delta', toolCallId: 'call-1', partialJson: inputJson };
      yield { type: 'tool_use_end', toolCallId: 'call-1', inputJson };
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
}

beforeEach(() => {
  vi.mocked(createSmartApprover).mockClear();
});

describe('createLazyProvider', () => {
  it('constructs at most once and only on demand', async () => {
    let constructed = 0;
    const { provider } = verdictProvider('{}');
    const get = createLazyProvider(async () => {
      constructed++;
      return provider;
    });

    expect(constructed).toBe(0);
    expect(await get()).toBe(provider);
    expect(await get()).toBe(provider);
    expect(constructed).toBe(1);
  });

  it('does not cache a failed construction', async () => {
    let attempts = 0;
    const { provider } = verdictProvider('{}');
    const get = createLazyProvider(async () => {
      attempts++;
      if (attempts === 1) throw new Error('no api key');
      return provider;
    });

    await expect(get()).rejects.toThrow('no api key');
    expect(await get()).toBe(provider);
    expect(attempts).toBe(2);
  });
});

describe('createApprovalDangerPredicate — personality resolution', () => {
  it('resolves the turn personality from session_start and enforces denyRules', async () => {
    const hooks = new DefaultHookRegistry();
    const { provider, calls } = verdictProvider('{"decision":"approve","reason":"fine"}');
    const isDangerous = createApprovalDangerPredicate({
      hooks: [hooks],
      personalities: registryWith(
        person('locked', { approvalMode: 'off', denyRules: ['git push --force'] }),
      ),
      getProvider: async () => provider,
      model: 'reviewer-model',
    });

    await hooks.fireVoid('session_start', {
      sessionId: 'sess-1',
      sessionKey: 'k',
      platform: 'web',
      personalityId: 'locked',
    });

    // The floor binds even under `approvalMode: 'off'`, and no reviewer runs.
    expect(await isDangerous(payload('shell', { command: 'git push --force origin main' }))).toBe(
      'denied by personality deny rule: git push --force',
    );
    expect(await isDangerous(payload('shell', { command: 'git status' }))).toBeNull();
    expect(calls()).toBe(0);
    expect(vi.mocked(createSmartApprover)).not.toHaveBeenCalled();
  });

  it('falls back to manual for a session it never saw', async () => {
    const hooks = new DefaultHookRegistry();
    const isDangerous = createApprovalDangerPredicate({
      hooks: [hooks],
      personalities: registryWith(person('locked', { denyRules: ['git push --force'] })),
      getProvider: async () => {
        throw new Error('provider must not be constructed');
      },
      model: 'reviewer-model',
    });

    // No `session_start` fired — an unresolved session must never pick up
    // another personality's policy.
    expect(
      await isDangerous(payload('shell', { command: 'git push --force' }, 'unknown')),
    ).toBeNull();
  });

  it('forgets the session personality once the turn ends', async () => {
    const hooks = new DefaultHookRegistry();
    const isDangerous = createApprovalDangerPredicate({
      hooks: [hooks],
      personalities: registryWith(person('locked', { denyRules: ['rm -rf ./build'] })),
      getProvider: async () => {
        throw new Error('provider must not be constructed');
      },
      model: 'reviewer-model',
    });

    await hooks.fireVoid('session_start', {
      sessionId: 'sess-1',
      sessionKey: 'k',
      platform: 'web',
      personalityId: 'locked',
    });
    expect(await isDangerous(payload('shell', { command: 'rm -rf ./build' }))).toMatch(/deny rule/);

    await hooks.fireVoid('agent_done', { sessionId: 'sess-1', text: '', turnCount: 1 });
    expect(await isDangerous(payload('shell', { command: 'rm -rf ./build' }))).toBeNull();
  });
});

describe('createApprovalDangerPredicate — smart mode', () => {
  it('routes a flagged call to the LLM reviewer', async () => {
    const hooks = new DefaultHookRegistry();
    const { provider, calls } = verdictProvider(
      '{"decision":"deny","reason":"sends mail to strangers"}',
    );
    let constructed = 0;
    const isDangerous = createApprovalDangerPredicate({
      hooks: [hooks],
      personalities: registryWith(person('reviewed', { approvalMode: 'smart' })),
      getProvider: createLazyProvider(async () => {
        constructed++;
        return provider;
      }),
      model: 'reviewer-model',
      alwaysAsk: ['email_send'],
    });

    await hooks.fireVoid('session_start', {
      sessionId: 'sess-1',
      sessionKey: 'k',
      platform: 'slack',
      personalityId: 'reviewed',
    });

    const reason = await isDangerous(payload('email_send', { to: 'a@b' }));

    expect(reason).toBe('denied by reviewer: sends mail to strangers');
    expect(calls()).toBe(1);
    expect(constructed).toBe(1);
    expect(vi.mocked(createSmartApprover)).toHaveBeenCalledTimes(1);
  });

  it('never constructs the reviewer or the provider when no personality declares smart', async () => {
    const hooks = new DefaultHookRegistry();
    let constructed = 0;
    const isDangerous = createApprovalDangerPredicate({
      hooks: [hooks],
      personalities: registryWith(person('plain'), person('explicit', { approvalMode: 'manual' })),
      getProvider: createLazyProvider(async () => {
        constructed++;
        throw new Error('provider must not be constructed');
      }),
      model: 'reviewer-model',
      alwaysAsk: ['email_send'],
    });

    for (const personalityId of ['plain', 'explicit']) {
      await hooks.fireVoid('session_start', {
        sessionId: personalityId,
        sessionKey: personalityId,
        platform: 'web',
        personalityId,
      });
      expect(await isDangerous(payload('email_send', { to: 'a@b' }, personalityId))).toBe(
        'email_send requires explicit approval',
      );
      expect(await isDangerous(payload('read_file', { path: 'x' }, personalityId))).toBeNull();
    }

    expect(constructed).toBe(0);
    expect(vi.mocked(createSmartApprover)).not.toHaveBeenCalled();
  });
});

describe('deny rules through a real agent turn', () => {
  it('blocks the tool call and relays the rule to the model', async () => {
    const hooks = new DefaultHookRegistry();
    const personalities = registryWith(
      person('locked', { approvalMode: 'off', denyRules: ['git push --force'] }),
    );
    const isDangerous = createApprovalDangerPredicate({
      hooks: [hooks],
      personalities,
      getProvider: async () => {
        throw new Error('provider must not be constructed');
      },
      model: 'reviewer-model',
    });
    // The same hook shape both approval surfaces use (web modal, Slack card):
    // a reason becomes the tool error the model sees.
    hooks.registerModifying('before_tool_call', async (p) => {
      const reason = await isDangerous(p);
      return reason === null ? null : { error: reason };
    });

    let executed = 0;
    const tools = new DefaultToolRegistry();
    tools.register({
      name: 'shell',
      description: 'run a command',
      schema: { type: 'object' },
      capabilities: {},
      execute: async () => {
        executed++;
        return { ok: true, value: 'ran' };
      },
    });

    const loop = new AgentLoop({
      llm: toolCallingLLM('shell', { command: 'git push --force origin main' }),
      tools,
      hooks,
      personalities,
      safety: createTestSafety(),
    });

    const events: AgentEvent[] = [];
    for await (const event of loop.run('ship it', {
      sessionKey: 'deny-rule',
      personalityId: 'locked',
    })) {
      events.push(event);
    }

    const toolEnd = events.find((e) => e.type === 'tool_end');
    expect(toolEnd).toMatchObject({ ok: false });
    expect(toolEnd && 'error' in toolEnd ? toolEnd.error : '').toContain(
      'denied by personality deny rule: git push --force',
    );
    expect(executed).toBe(0);
  });
});

describe('entry-point wiring', () => {
  // The regression this guards: all three surfaces used to call
  // `createDangerPredicate()` with no arguments, which pinned every
  // personality to `manual` and made `denyRules` / `approvalMode` inert.
  const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
  const ENTRY_POINTS = [
    'apps/ethos/src/commands/serve.ts',
    'apps/ethos/src/commands/gateway.ts',
    'apps/desktop/src/main/serve.ts',
  ];

  it.each(ENTRY_POINTS)('%s builds its danger predicate with the seams', (relPath) => {
    const src = readFileSync(join(ROOT, relPath), 'utf-8');
    expect(src).toContain('createApprovalDangerPredicate({');
    expect(src).not.toMatch(/createDangerPredicate\(\s*\)/);
  });
});
