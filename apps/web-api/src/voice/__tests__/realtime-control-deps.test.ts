import { DefaultToolRegistry, InMemorySessionStore } from '@ethosagent/core';
import { AGENT_CONSULT_TOOL } from '@ethosagent/tools-voice';
import type { SessionStore, Tool } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  createRealtimeControlDeps,
  type RealtimeBudgetAuthority,
  type RealtimeControlDepsOptions,
} from '../realtime-control-deps';

function consultTool(): Tool {
  return {
    name: AGENT_CONSULT_TOOL,
    description: 'ask the assistant',
    toolset: 'voice',
    capabilities: {},
    schema: { type: 'object', properties: {} },
    async execute() {
      return { ok: true, value: 'answered' };
    },
  };
}

function build(
  sessions: SessionStore,
  fallbackClientId = 'lane-1',
  extra: Partial<RealtimeControlDepsOptions> = {},
) {
  const registry = new DefaultToolRegistry();
  registry.register(consultTool());
  return createRealtimeControlDeps(
    {
      toolRegistry: registry,
      sessions,
      personalities: { get: () => ({ toolset: ['read_file'] }) },
      defaults: { model: 'm', provider: 'p' },
      ...extra,
    },
    fallbackClientId,
  );
}

/** A stand-in for `AgentLoop`'s per-session cost map + personality caps. */
function fakeBudget(personalityCapUsd?: number): RealtimeBudgetAuthority & { spend: number } {
  return {
    spend: 0,
    addSessionCost(_key, usd) {
      this.spend += usd;
    },
    getSessionCost() {
      return this.spend;
    },
    getPersonalityBudgetCap() {
      return personalityCapUsd;
    },
  };
}

describe('talk-session binding', () => {
  it('keys the talk session on the chat session, in the voice namespace', async () => {
    const sessions = new InMemorySessionStore();
    const binding = await build(sessions).open({ sessionId: 'chat-9', personalityId: 'ada' });

    expect(binding.laneKey).toBe('voice:web:browser:chat-9');
  });

  it('falls back to the connection id when talk-mode opens before a chat exists', async () => {
    const sessions = new InMemorySessionStore();
    const binding = await build(sessions, 'lane-7-abc').open({});

    expect(binding.laneKey).toBe('voice:web:browser:lane-7-abc');
  });

  it('resumes the same talk session on reconnect rather than forking a new one', async () => {
    const sessions = new InMemorySessionStore();
    const deps = build(sessions);
    const first = await deps.open({ sessionId: 'chat-9' });
    const second = await deps.open({ sessionId: 'chat-9' });

    expect(second.storeSessionId).toBe(first.storeSessionId);
  });

  it('does not interleave with the typed chat in the same browser session', async () => {
    // The OpenClaw #112253 failure. A typed send and a spoken consult in one
    // browser session must not append to one message list: `chat.send` writes
    // to `web:<uuid>`, the talk session writes to `voice:web:browser:<id>`.
    const sessions = new InMemorySessionStore();
    const typed = await sessions.createSession({
      key: 'web:chat-9',
      platform: 'web',
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
    await sessions.appendMessage({ sessionId: typed.id, role: 'user', content: 'typed question' });

    const deps = build(sessions);
    const binding = await deps.open({ sessionId: 'chat-9' });
    await deps.persistTranscript(binding, 'user', 'spoken question');

    expect(binding.storeSessionId).not.toBe(typed.id);
    expect((await sessions.getMessages(typed.id)).map((m) => m.content)).toEqual([
      'typed question',
    ]);
    expect((await sessions.getMessages(binding.storeSessionId)).map((m) => m.content)).toEqual([
      'spoken question',
    ]);
  });

  it('binds the per-audio-minute rate the roster entry declares', async () => {
    const sessions = new InMemorySessionStore();
    const binding = await build(sessions, 'lane-1', {
      pricing: async () => ({ costPerMinuteUsd: 0.06, sessionBudgetUsd: 1.5 }),
    }).open({ sessionId: 'chat-9' });

    expect(binding.costPerMinuteUsd).toBe(0.06);
    expect(binding.sessionBudgetUsd).toBe(1.5);
  });

  it('leaves an unpriced entry unpriced rather than free', async () => {
    const sessions = new InMemorySessionStore();
    const binding = await build(sessions, 'lane-1', {
      pricing: async () => ({ sessionBudgetUsd: 1.5 }),
    }).open({ sessionId: 'chat-9' });

    expect(binding.costPerMinuteUsd).toBeUndefined();
  });

  it('takes the LOWER of the session cap and the personality cap', async () => {
    // Two caps that ignore each other is a trap: the personality cap already
    // governs this lane key (that is where `agent_consult` runs its turns), so
    // the lower of the two is what actually binds — and the lane winding down
    // on it is what turns a silently refused consult into a spoken sign-off.
    const sessions = new InMemorySessionStore();
    const personalityLower = await build(sessions, 'lane-1', {
      pricing: async () => ({ sessionBudgetUsd: 5 }),
      budget: fakeBudget(2),
    }).open({ sessionId: 'chat-9' });
    expect(personalityLower.sessionBudgetUsd).toBe(2);

    const sessionLower = await build(sessions, 'lane-2', {
      pricing: async () => ({ sessionBudgetUsd: 0.5 }),
      budget: fakeBudget(2),
    }).open({ sessionId: 'chat-8' });
    expect(sessionLower.sessionBudgetUsd).toBe(0.5);
  });

  it('is uncapped when neither cap is set', async () => {
    const sessions = new InMemorySessionStore();
    const binding = await build(sessions, 'lane-1', {
      pricing: async () => ({ costPerMinuteUsd: 0.06 }),
      budget: fakeBudget(),
    }).open({ sessionId: 'chat-9' });

    expect(binding.sessionBudgetUsd).toBeUndefined();
  });

  it('folds accrued audio cost into the loop budget AND the session row', async () => {
    const sessions = new InMemorySessionStore();
    const budget = fakeBudget();
    const deps = build(sessions, 'lane-1', {
      pricing: async () => ({ costPerMinuteUsd: 0.06 }),
      budget,
    });
    const binding = await deps.open({ sessionId: 'chat-9' });

    deps.onUsage?.(binding, {
      type: 'usage',
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0.03,
    });
    await Promise.resolve();

    // Where `budgetCapUsd` and every budget halt read from...
    expect(budget.getSessionCost(binding.laneKey)).toBeCloseTo(0.03, 10);
    expect(deps.sessionSpendUsd?.(binding)).toBeCloseTo(0.03, 10);
    // ...and where `/usage` and the Sessions tab read from.
    const row = await sessions.getSession(binding.storeSessionId);
    expect(row?.usage.estimatedCostUsd).toBeCloseTo(0.03, 10);
  });

  it('binds a tool host whose advertised list is what it will service', async () => {
    const sessions = new InMemorySessionStore();
    const binding = await build(sessions).open({ sessionId: 'chat-9', personalityId: 'ada' });

    expect(binding.host.handled).toEqual([AGENT_CONSULT_TOOL]);
    expect(binding.host.definitions.map((d) => d.name)).toEqual(binding.host.handled);
  });
});
