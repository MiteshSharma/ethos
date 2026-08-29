import type { AgentLoop } from '@ethosagent/core';
import { DefaultHookRegistry } from '@ethosagent/core';
import type { DeliveryResult, InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { Gateway } from '../index';

// A fake AgentLoop whose `run()` lets the test drive the turn lifecycle:
// it fires `session_start` (as the real loop does at step 2), then awaits a
// gate the test resolves to end the turn. This mirrors the real ordering an
// approval depends on — the hook fires, the turn is paused, the approval is
// resolved, the turn ends.
function makeFakeLoop(): {
  loop: AgentLoop;
  // Resolves the in-flight turn for a given sessionKey.
  endTurn: (sessionKey: string) => void;
  // Resolves once `run()` has fired session_start for a given sessionKey.
  turnStarted: (sessionKey: string) => Promise<void>;
} {
  const hooks = new DefaultHookRegistry();
  const turnGates = new Map<string, () => void>();
  const startSignals = new Map<string, () => void>();

  const loop = {
    hooks,
    async *run(_text: string, opts: { sessionKey?: string } = {}) {
      const sessionKey = opts.sessionKey ?? 'default';
      // Step 2 of the real loop — fire session_start with both ids. The
      // gateway's session_start hook bridges sessionId → routing here.
      await hooks.fireVoid('session_start', {
        sessionId: `sid-${sessionKey}`,
        sessionKey,
        platform: 'slack',
      });
      startSignals.get(sessionKey)?.();
      // Pause the turn until the test ends it.
      await new Promise<void>((resolve) => {
        turnGates.set(sessionKey, resolve);
      });
      yield { type: 'done' as const, text: '', turnCount: 1 };
    },
  } as unknown as AgentLoop;

  return {
    loop,
    endTurn: (sessionKey) => turnGates.get(sessionKey)?.(),
    turnStarted: (sessionKey) =>
      new Promise<void>((resolve) => {
        startSignals.set(sessionKey, resolve);
      }),
  };
}

function makeFakeAdapter(): PlatformAdapter {
  return {
    id: 'slack:bot-1',
    displayName: 'Slack',
    capabilities: { platform: 'test' },
    canSendTyping: false,
    canEditMessage: true,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 3000,
    async start() {},
    async stop() {},
    async send(): Promise<DeliveryResult> {
      return { ok: true, messageId: 'm1' };
    },
    onMessage() {},
    async health() {
      return { ok: true };
    },
  };
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'slack',
    botKey: 'bot-1',
    chatId: 'C123',
    userId: 'U1',
    text: 'hello',
    isDm: false,
    isGroupMention: true,
    raw: null,
    ...overrides,
  };
}

describe('Gateway.resolveApprovalRoute', () => {
  it('resolves sessionId → routing while a turn is in flight', async () => {
    const { loop, endTurn, turnStarted } = makeFakeLoop();
    const adapter = makeFakeAdapter();
    const gateway = new Gateway({
      bots: [{ botKey: 'bot-1', loop, binding: { type: 'personality', name: 'p' } }],
    });

    const laneKey = 'slack:bot-1:C123:1700000000.5';
    const started = turnStarted(laneKey);
    const turn = gateway.handleMessage(inbound({ threadId: '1700000000.5' }), adapter);

    await started;

    const route = gateway.resolveApprovalRoute(`sid-${laneKey}`);
    expect(route).toBeDefined();
    expect(route?.adapter).toBe(adapter);
    expect(route?.chatId).toBe('C123');
    expect(route?.threadId).toBe('1700000000.5');
    expect(route?.requesterUserId).toBe('U1');

    endTurn(laneKey);
    await turn;
  });

  it('returns undefined for an unknown sessionId', () => {
    const { loop } = makeFakeLoop();
    const gateway = new Gateway({
      bots: [{ botKey: 'bot-1', loop, binding: { type: 'personality', name: 'p' } }],
    });
    expect(gateway.resolveApprovalRoute('sid-nonexistent')).toBeUndefined();
  });

  it('cleans up the route once the turn ends', async () => {
    const { loop, endTurn, turnStarted } = makeFakeLoop();
    const adapter = makeFakeAdapter();
    const gateway = new Gateway({
      bots: [{ botKey: 'bot-1', loop, binding: { type: 'personality', name: 'p' } }],
    });

    const laneKey = 'slack:bot-1:C123';
    const started = turnStarted(laneKey);
    const turn = gateway.handleMessage(inbound(), adapter);
    await started;

    expect(gateway.resolveApprovalRoute(`sid-${laneKey}`)).toBeDefined();

    endTurn(laneKey);
    await turn;

    expect(gateway.resolveApprovalRoute(`sid-${laneKey}`)).toBeUndefined();
  });

  it('keeps routing isolated for concurrent same-chat turns across two bots', async () => {
    // Regression guard: two bots, two adapters, the SAME chatId in flight at
    // once. The routing bridge keys off `sessionKey`, which the gateway
    // derives from the lane key — and the lane key includes `botKey`. So the
    // two turns must NOT collide: each `sessionId` resolves to its own
    // adapter / requester, never the other bot's.
    const a = makeFakeLoop();
    const b = makeFakeLoop();
    const adapterA = makeFakeAdapter();
    const adapterB = makeFakeAdapter();
    const gateway = new Gateway({
      bots: [
        { botKey: 'bot-a', loop: a.loop, binding: { type: 'personality', name: 'p' } },
        { botKey: 'bot-b', loop: b.loop, binding: { type: 'personality', name: 'p' } },
      ],
    });

    const laneA = 'slack:bot-a:C123';
    const laneB = 'slack:bot-b:C123';
    const startedA = a.turnStarted(laneA);
    const startedB = b.turnStarted(laneB);
    const turnA = gateway.handleMessage(
      inbound({ botKey: 'bot-a', chatId: 'C123', userId: 'U-a' }),
      adapterA,
    );
    const turnB = gateway.handleMessage(
      inbound({ botKey: 'bot-b', chatId: 'C123', userId: 'U-b' }),
      adapterB,
    );
    await Promise.all([startedA, startedB]);

    const routeA = gateway.resolveApprovalRoute(`sid-${laneA}`);
    const routeB = gateway.resolveApprovalRoute(`sid-${laneB}`);
    expect(routeA?.adapter).toBe(adapterA);
    expect(routeA?.requesterUserId).toBe('U-a');
    expect(routeB?.adapter).toBe(adapterB);
    expect(routeB?.requesterUserId).toBe('U-b');

    a.endTurn(laneA);
    b.endTurn(laneB);
    await Promise.all([turnA, turnB]);
  });
});

describe('Gateway.hasActiveTurns', () => {
  it('is false when idle, true during a turn, and false again once it ends', async () => {
    const { loop, endTurn, turnStarted } = makeFakeLoop();
    const adapter = makeFakeAdapter();
    const gateway = new Gateway({
      bots: [{ botKey: 'bot-1', loop, binding: { type: 'personality', name: 'p' } }],
    });

    expect(gateway.hasActiveTurns()).toBe(false);

    const laneKey = 'slack:bot-1:C123';
    const started = turnStarted(laneKey);
    const turn = gateway.handleMessage(inbound(), adapter);
    await started;

    expect(gateway.hasActiveTurns()).toBe(true);

    endTurn(laneKey);
    await turn;

    expect(gateway.hasActiveTurns()).toBe(false);
  });
});
