// Gateway clarify correlator — the new pre-routing step that short-circuits
// inbound messages which are actually answers to a pending clarify
// (force-reply or `/cancel`). When the correlator returns a response, the
// gateway must resolve the bot's bridge and stop processing — no agent
// invocation, no safety filter, no lane enqueue.

import type { AgentLoop, ClarifyBridge } from '@ethosagent/core';
import { DefaultHookRegistry } from '@ethosagent/core';
import type {
  ClarifyResponse,
  DeliveryResult,
  InboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';

function makeFakeLoop(bridge: ClarifyBridge): AgentLoop {
  const hooks = new DefaultHookRegistry();
  const runs: string[] = [];
  const loop = {
    hooks,
    clarifyBridge: bridge,
    runs,
    async *run(text: string) {
      runs.push(text);
      yield { type: 'done' as const, text: '', turnCount: 1 };
    },
  } as unknown as AgentLoop & { runs: string[] };
  return loop;
}

function makeFakeAdapter(): PlatformAdapter {
  return {
    id: 'telegram:bot-1',
    displayName: 'Telegram',
    capabilities: { platform: 'test' },
    canSendTyping: true,
    canEditMessage: true,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
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
    platform: 'telegram',
    botKey: 'bot-1',
    chatId: 'C1',
    userId: 'U1',
    text: 'free-form answer',
    isDm: true,
    isGroupMention: false,
    raw: null,
    ...overrides,
  };
}

describe('Gateway — clarifyMessageCorrelator short-circuit', () => {
  it('routes a correlated inbound to bridge.respond and does NOT invoke the agent loop', async () => {
    const bridge = {
      respond: vi.fn(async () => {}),
      sweep: vi.fn(async () => {}),
    } as unknown as ClarifyBridge;
    const loop = makeFakeLoop(bridge);
    const adapter = makeFakeAdapter();

    const expected: ClarifyResponse = { requestId: 'r1', answer: 'sqlite', source: 'user' };
    const correlator = vi.fn(async () => expected);

    const gateway = new Gateway({
      bots: [{ botKey: 'bot-1', loop, binding: { type: 'personality', name: 'p' } }],
      clarifyMessageCorrelator: correlator,
      clarifySweepIntervalMs: 0,
    });

    await gateway.handleMessage(inbound({ replyToId: 'prompt-1' }), adapter);

    expect(correlator).toHaveBeenCalledTimes(1);
    expect(bridge.respond).toHaveBeenCalledWith(expected);
    expect((loop as unknown as { runs: string[] }).runs).toEqual([]);
  });

  it('continues to normal routing when the correlator returns null', async () => {
    const bridge = {
      respond: vi.fn(),
      sweep: vi.fn(async () => {}),
      // Fix 5 (pi-delegation.md D7) — an ordinary message that reaches
      // normal routing now records presence too; this fake bridge needs the
      // method to exist.
      recordPresence: vi.fn(),
    } as unknown as ClarifyBridge;
    const loop = makeFakeLoop(bridge);
    const adapter = makeFakeAdapter();
    const correlator = vi.fn(async () => null);

    const gateway = new Gateway({
      bots: [{ botKey: 'bot-1', loop, binding: { type: 'personality', name: 'p' } }],
      clarifyMessageCorrelator: correlator,
      clarifySweepIntervalMs: 0,
    });

    await gateway.handleMessage(inbound(), adapter);

    expect(correlator).toHaveBeenCalled();
    expect(bridge.respond).not.toHaveBeenCalled();
    // The fake loop's run() was invoked — message reached normal routing.
    expect((loop as unknown as { runs: string[] }).runs.length).toBeGreaterThan(0);
  });

  it('does NOT call the correlator for senders outside the channel allowlist (group chat bypass)', async () => {
    const bridge = {
      respond: vi.fn(async () => {}),
      sweep: vi.fn(async () => {}),
    } as unknown as ClarifyBridge;
    const loop = makeFakeLoop(bridge);
    const adapter = makeFakeAdapter();
    // The correlator would normally match — but the gateway must not even
    // call it when the sender is not on the allowlist for a group chat.
    const correlator = vi.fn(async () => ({
      requestId: 'r1',
      answer: 'sqlite',
      source: 'user' as const,
    }));

    const gateway = new Gateway({
      bots: [{ botKey: 'bot-1', loop, binding: { type: 'personality', name: 'p' } }],
      clarifyMessageCorrelator: correlator,
      clarifySweepIntervalMs: 0,
      channelFilter: {
        telegram: {
          ownerUserId: 'owner-1',
          recipientAllowlist: ['allowed-1'],
        },
      },
    });

    await gateway.handleMessage(
      inbound({
        userId: 'random-stranger',
        isDm: false,
        replyToId: 'prompt-1',
      }),
      adapter,
    );

    expect(correlator).not.toHaveBeenCalled();
    expect(bridge.respond).not.toHaveBeenCalled();
  });

  it('runs the correlator for allowlisted senders in a group chat (no mention required)', async () => {
    const bridge = {
      respond: vi.fn(async () => {}),
      sweep: vi.fn(async () => {}),
    } as unknown as ClarifyBridge;
    const loop = makeFakeLoop(bridge);
    const adapter = makeFakeAdapter();
    const expected: ClarifyResponse = { requestId: 'r1', answer: 'sqlite', source: 'user' };
    const correlator = vi.fn(async () => expected);

    const gateway = new Gateway({
      bots: [{ botKey: 'bot-1', loop, binding: { type: 'personality', name: 'p' } }],
      clarifyMessageCorrelator: correlator,
      clarifySweepIntervalMs: 0,
      channelFilter: {
        telegram: {
          ownerUserId: 'owner-1',
          recipientAllowlist: ['allowed-1'],
        },
      },
    });

    await gateway.handleMessage(
      inbound({
        userId: 'allowed-1',
        isDm: false,
        isGroupMention: false, // a force-reply has no @-mention; that's the point
        replyToId: 'prompt-1',
      }),
      adapter,
    );

    expect(correlator).toHaveBeenCalledTimes(1);
    expect(bridge.respond).toHaveBeenCalledWith(expected);
  });

  it('runs the periodic sweep on the configured interval', async () => {
    vi.useFakeTimers();
    const bridge = {
      respond: vi.fn(),
      sweep: vi.fn(async () => {}),
    } as unknown as ClarifyBridge;
    const loop = makeFakeLoop(bridge);

    const gateway = new Gateway({
      bots: [{ botKey: 'bot-1', loop, binding: { type: 'personality', name: 'p' } }],
      clarifySweepIntervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(250);
    expect((bridge.sweep as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);

    await gateway.shutdown();
    const callsAtShutdown = (bridge.sweep as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    // No new sweep calls after shutdown — timer was cleared.
    expect((bridge.sweep as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAtShutdown);

    vi.useRealTimers();
  });
});
