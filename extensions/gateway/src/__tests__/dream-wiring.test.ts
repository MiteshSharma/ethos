import type { AgentLoop } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { InboundMessage, PersonalityConfig, PlatformAdapter } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DreamExecutor } from '../dream-executor';
import { Gateway } from '../index';

// The `onUserTurn` seam is the gateway's activity signal: it carries the
// personality a lane turn resolved to, and the CLI gateway command feeds it to
// DreamExecutor.recordUserTurn(). These tests exercise that pairing end to end
// — a real Gateway turn on one side, a real DreamExecutor tick on the other.

function stubAdapter(): PlatformAdapter {
  return {
    id: 'test',
    displayName: 'Test',
    capabilities: { platform: 'test' },
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({ ok: true, messageId: '1' }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function stubLoop() {
  return {
    run: vi.fn(async function* (_text: string, _opts?: Record<string, unknown>) {
      yield { type: 'done' as const, text: 'reply', turnCount: 1 };
    }),
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
  };
}

function makeMessage(id: string): InboundMessage {
  return {
    platform: 'test',
    chatId: '100',
    userId: '200',
    text: 'hello',
    isDm: true,
    isGroupMention: false,
    messageId: id,
    botKey: 'test-bot',
    raw: {},
  };
}

type Internals = { tick(): Promise<void> };
const internals = (e: DreamExecutor) => e as unknown as Internals;

const personalityId = 'assistant';

describe('Gateway → DreamExecutor wiring', () => {
  let storage: InMemoryStorage;
  let dreamLoop: ReturnType<typeof stubLoop>;
  let executor: DreamExecutor;

  beforeEach(async () => {
    vi.useFakeTimers();
    storage = new InMemoryStorage();
    await storage.mkdir(`personalities/${personalityId}`);
    dreamLoop = stubLoop();
  });

  afterEach(() => {
    executor?.stop();
    vi.useRealTimers();
  });

  /** Gateway + executor wired the way `apps/ethos/src/commands/gateway.ts` does. */
  function wire(config: PersonalityConfig) {
    executor = new DreamExecutor(
      storage,
      () => dreamLoop as unknown as AgentLoop,
      () => config,
    );
    const gateway = new Gateway({
      bots: [
        {
          botKey: 'test-bot',
          loop: stubLoop() as unknown as AgentLoop,
          binding: { type: 'personality', name: personalityId },
        },
      ],
      clarifySweepIntervalMs: 0,
      onUserTurn: ({ personalityId: id }) => executor.recordUserTurn(id),
    });
    return gateway;
  }

  it('a channel turn arms the idle clock, and the personality dreams once idle', async () => {
    const gateway = wire({
      id: personalityId,
      name: 'Assistant',
      dreaming: { enable: true, idleMinutes: 60, maxPerDay: 1 },
    } as PersonalityConfig);

    await gateway.handleMessage(makeMessage('1'), stubAdapter());

    // Still mid-conversation — no dream.
    await internals(executor).tick();
    expect(dreamLoop.run).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 61 * 60_000);
    await internals(executor).tick();

    expect(dreamLoop.run).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(dreamLoop.run).mock.calls[0]?.[1];
    expect(opts?.personalityId).toBe(personalityId);
    expect(opts?.sessionKey).toMatch(new RegExp(`^dream:${personalityId}:`));
    expect(opts?.tierOverride).toBe('dreaming');
  });

  it('a personality with no dreaming block never dreams, however long it idles', async () => {
    const gateway = wire({ id: personalityId, name: 'Assistant' } as PersonalityConfig);

    await gateway.handleMessage(makeMessage('1'), stubAdapter());

    vi.setSystemTime(Date.now() + 48 * 60 * 60_000);
    await internals(executor).tick();

    expect(dreamLoop.run).not.toHaveBeenCalled();
    expect(await storage.read(`personalities/${personalityId}/dream-state.json`)).toBeNull();
  });

  it('dreaming: { enable: false } never dreams', async () => {
    const gateway = wire({
      id: personalityId,
      name: 'Assistant',
      dreaming: { enable: false, idleMinutes: 60, maxPerDay: 1 },
    } as PersonalityConfig);

    await gateway.handleMessage(makeMessage('1'), stubAdapter());

    vi.setSystemTime(Date.now() + 48 * 60 * 60_000);
    await internals(executor).tick();

    expect(dreamLoop.run).not.toHaveBeenCalled();
  });

  it('fires onUserTurn at turn start, before the lane turn runs', async () => {
    // Ordering matters: the executor aborts an in-flight dream from this
    // signal, which is only useful if it lands before the user's turn — a
    // completion-time signal would arrive after the whole turn had run.
    const order: string[] = [];
    const botLoop = {
      run: vi.fn(async function* (_text: string, _opts?: Record<string, unknown>) {
        order.push('turn');
        yield { type: 'done' as const, text: 'reply', turnCount: 1 };
      }),
      hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
    };
    const gateway = new Gateway({
      bots: [
        {
          botKey: 'test-bot',
          loop: botLoop as unknown as AgentLoop,
          binding: { type: 'personality', name: personalityId },
        },
      ],
      clarifySweepIntervalMs: 0,
      onUserTurn: ({ personalityId: id }) => order.push(`signal:${id}`),
    });

    await gateway.handleMessage(makeMessage('1'), stubAdapter());

    expect(order).toEqual([`signal:${personalityId}`, 'turn']);
  });
});
