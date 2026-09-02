// plan/phases/gateway-live-reload.md Phase A — the Gateway API surface (§2)
// and the hazards §3 names for it.
//
// What is proven here: a bot added to a RUNNING gateway routes messages, a bot
// removed from one drains its own in-flight turn before its adapter stops, and
// neither touches the other bots. The `apps/ethos` half of Phase A (the config
// reconciler and its refusal rules) is covered by
// `apps/ethos/src/__tests__/gateway-live-reload.test.ts`.

import type { AgentLoop } from '@ethosagent/core';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** An adapter that hands back the handler the gateway wires into it. */
function capturingAdapter(id: string) {
  let handler: ((m: InboundMessage) => void) | undefined;
  const sent: Array<{ chatId: string; text: string | undefined }> = [];
  const adapter: PlatformAdapter = {
    id,
    displayName: id,
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (chatId: string, body: { text?: string }) => {
      sent.push({ chatId, text: body.text });
      return { ok: true, messageId: `m-${sent.length}` };
    }),
    onMessage: vi.fn((h: (m: InboundMessage) => void) => {
      handler = h;
    }),
    health: vi.fn().mockResolvedValue({ ok: true }),
  };
  return {
    adapter,
    sent,
    deliver: (msg: InboundMessage) => {
      if (!handler) throw new Error(`${id}: nothing wired onMessage`);
      handler(msg);
    },
  };
}

/** A loop whose turn parks on a gate until released. */
function gatedLoop() {
  const gates: Array<() => void> = [];
  const state = { started: 0 };
  const loop = {
    run: vi.fn(async function* () {
      state.started++;
      await new Promise<void>((res) => gates.push(res));
      yield { type: 'text_delta' as const, text: 'reply' };
      yield { type: 'done' as const, text: 'reply', turnCount: 1 };
    }),
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
  };
  return {
    loop: loop as unknown as AgentLoop,
    state,
    parked: () => gates.length,
    releaseAll: () => {
      while (gates.length) gates.shift()?.();
    },
  };
}

/**
 * A loop whose turn ignores its gate and only ends when its abort signal
 * fires — a wedged turn, which is what a drain TIMEOUT is about. `unwindMs`
 * is the tail the turn still needs after being told to stop; the adapter must
 * not be torn out from under it during that window.
 */
function wedgedLoop(unwindMs = 20) {
  const state = { started: 0, aborted: false, finished: 0 };
  const loop = {
    run: vi.fn(async function* (_text: string, opts: { abortSignal: AbortSignal }) {
      state.started++;
      await new Promise<void>((resolve) => {
        if (opts.abortSignal.aborted) {
          state.aborted = true;
          resolve();
          return;
        }
        opts.abortSignal.addEventListener(
          'abort',
          () => {
            state.aborted = true;
            setTimeout(resolve, unwindMs);
          },
          { once: true },
        );
      });
      state.finished++;
      yield { type: 'done' as const, text: '', turnCount: 1 };
    }),
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
  };
  return { loop: loop as unknown as AgentLoop, state };
}

/** A loop carrying a clarify bridge, so the sweep timer has something to tick. */
function bridgedLoop() {
  const sweep = vi.fn().mockResolvedValue(undefined);
  const loop = {
    run: vi.fn(async function* () {
      yield { type: 'done' as const, text: '', turnCount: 1 };
    }),
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
    clarifyBridge: { sweep },
  };
  return { loop: loop as unknown as AgentLoop, sweep };
}

function message(botKey: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'test',
    chatId: `chat-${botKey}`,
    userId: 'user-1',
    text: 'hello',
    isDm: true,
    isGroupMention: false,
    botKey,
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    raw: {},
    ...overrides,
  };
}

function makeGateway() {
  const first = capturingAdapter('test:b1');
  const firstLoop = gatedLoop();
  const gw = new Gateway({
    bots: [{ botKey: 'b1', loop: firstLoop.loop, binding: { type: 'personality', name: 'a' } }],
    botAdapters: new Map([['b1', first.adapter]]),
    adapters: new Map([['test', first.adapter]]),
  });
  // Cold-boot adapters are wired by the app, not the Gateway — mirror that.
  first.adapter.onMessage((m) => void gw.handleMessage(m, first.adapter));
  return { gw, first, firstLoop };
}

describe('Gateway — live adapter add/remove (Phase A)', () => {
  it('lists the adapters and bots it was constructed with', () => {
    const { gw, first } = makeGateway();
    expect(gw.listAdapters()).toEqual([first.adapter]);
    expect(gw.listBots().map((b) => b.botKey)).toEqual(['b1']);
  });

  it('lists construction-time adapters even without the optional botAdapters map', () => {
    // `listAdapters()` used to answer ONLY from `GatewayConfig.botAdapters`, so
    // a caller that passed just the platform-keyed `adapters` map — everything
    // the constructor already receives — got an empty list back while adapters
    // were demonstrably live. The registry is now seeded from those too: each
    // value names its own bot in `adapter.id`.
    const only = capturingAdapter('test:b1');
    const gw = new Gateway({
      bots: [{ botKey: 'b1', loop: gatedLoop().loop, binding: { type: 'personality', name: 'a' } }],
      adapters: new Map([['test', only.adapter]]),
    });
    expect(gw.listAdapters()).toEqual([only.adapter]);
  });

  it('resolves removeAdapter through an adapter it recovered from `adapters`', async () => {
    const only = capturingAdapter('test:b1');
    const gw = new Gateway({
      bots: [{ botKey: 'b1', loop: gatedLoop().loop, binding: { type: 'personality', name: 'a' } }],
      adapters: new Map([['test', only.adapter]]),
    });
    await gw.removeAdapter('b1');
    expect(only.adapter.stop).toHaveBeenCalledTimes(1);
    expect(gw.listAdapters()).toEqual([]);
  });

  it('hot-adds a bot that then receives a message end to end', async () => {
    const { gw } = makeGateway();
    const second = capturingAdapter('test:b2');
    const secondLoop = gatedLoop();

    gw.addAdapter(second.adapter, {
      botKey: 'b2',
      loop: secondLoop.loop,
      binding: { type: 'personality', name: 'b' },
    });

    expect(gw.listAdapters()).toHaveLength(2);
    expect(gw.listBots().map((b) => b.botKey)).toEqual(['b1', 'b2']);

    second.deliver(message('b2'));
    await waitUntil(() => secondLoop.parked() > 0);
    secondLoop.releaseAll();
    await waitUntil(() => second.sent.length > 0);
    expect(second.sent[0]?.text).toBe('reply');
  });

  it('refuses a duplicate botKey instead of replacing the live entry', () => {
    const { gw, firstLoop } = makeGateway();
    const clash = capturingAdapter('test:b1-again');
    expect(() =>
      gw.addAdapter(clash.adapter, {
        botKey: 'b1',
        loop: firstLoop.loop,
        binding: { type: 'personality', name: 'a' },
      }),
    ).toThrow(/already registered/);
    expect(gw.listAdapters()).toHaveLength(1);
  });

  it('drains an in-flight turn before the removed adapter stops, and leaves the others running', async () => {
    const { gw, first, firstLoop } = makeGateway();
    const second = capturingAdapter('test:b2');
    const secondLoop = gatedLoop();
    gw.addAdapter(second.adapter, {
      botKey: 'b2',
      loop: secondLoop.loop,
      binding: { type: 'personality', name: 'b' },
    });

    // A turn in flight on the bot about to be removed.
    second.deliver(message('b2'));
    await waitUntil(() => secondLoop.parked() > 0);

    let resolved = false;
    const removal = gw.removeAdapter('b2').then(() => {
      resolved = true;
    });

    // The turn is still parked: neither the removal nor the stop may complete.
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(false);
    expect(second.adapter.stop).not.toHaveBeenCalled();
    // The still-running bot's own turn finished, so its reply landed.
    expect(first.adapter.stop).not.toHaveBeenCalled();

    secondLoop.releaseAll();
    await removal;
    expect(resolved).toBe(true);
    expect(second.adapter.stop).toHaveBeenCalledTimes(1);
    // The drain waited for the turn: its reply was delivered before stop().
    expect(second.sent).toHaveLength(1);

    // b2 is gone from both views; b1 is untouched and still serves turns.
    expect(gw.listBots().map((b) => b.botKey)).toEqual(['b1']);
    expect(gw.listAdapters()).toEqual([first.adapter]);
    first.deliver(message('b1'));
    await waitUntil(() => firstLoop.parked() > 0);
    firstLoop.releaseAll();
    await waitUntil(() => first.sent.length > 0);
    expect(first.adapter.stop).not.toHaveBeenCalled();
  });

  it('stops routing to a removed bot, and allows the same botKey to be re-added', async () => {
    const { gw } = makeGateway();
    const second = capturingAdapter('test:b2');
    const secondLoop = gatedLoop();
    const entry = {
      botKey: 'b2',
      loop: secondLoop.loop,
      binding: { type: 'personality' as const, name: 'b' },
    };
    gw.addAdapter(second.adapter, entry);
    await gw.removeAdapter('b2');

    // Deliveries from the stopped adapter no longer resolve to a bot.
    second.deliver(message('b2'));
    await new Promise((r) => setTimeout(r, 20));
    expect(secondLoop.state.started).toBe(0);

    const replacement = capturingAdapter('test:b2');
    gw.addAdapter(replacement.adapter, entry);
    expect(gw.listBots().map((b) => b.botKey)).toEqual(['b1', 'b2']);
  });

  it('removing an unknown botKey is a no-op', async () => {
    const { gw, first } = makeGateway();
    await expect(gw.removeAdapter('nope')).resolves.toBeUndefined();
    expect(gw.listAdapters()).toEqual([first.adapter]);
  });
});

// ---------------------------------------------------------------------------
// removeAdapter — deregister AFTER the drain, not before
// ---------------------------------------------------------------------------

describe('Gateway — removeAdapter drains before it deregisters', () => {
  it('keeps routing work that was accepted before the removal, and refuses new work', async () => {
    const { gw } = makeGateway();
    const second = capturingAdapter('test:b2');
    const secondLoop = gatedLoop();
    gw.addAdapter(second.adapter, {
      botKey: 'b2',
      loop: secondLoop.loop,
      binding: { type: 'personality', name: 'b' },
    });

    // Two lanes of work accepted while the bot is fully live.
    second.deliver(message('b2', { chatId: 'chat-a', messageId: 'a1' }));
    second.deliver(message('b2', { chatId: 'chat-b', messageId: 'b1' }));
    await waitUntil(() => secondLoop.parked() === 2);

    let resolved = false;
    const removal = gw.removeAdapter('b2').then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 10));

    // Mid-drain: the bot is STILL in the routing table, because the work in
    // flight was admitted under it and has to finish under it.
    expect(gw.listBots().map((b) => b.botKey)).toContain('b2');
    expect(resolved).toBe(false);

    // …but nothing new is admitted, or the drain would chase a moving target.
    second.deliver(message('b2', { chatId: 'chat-c', messageId: 'c1' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(secondLoop.state.started).toBe(2);

    // Both accepted turns complete and both replies go out BEFORE the stop.
    secondLoop.releaseAll();
    await removal;
    expect(second.sent.map((s) => s.chatId).sort()).toEqual(['chat-a', 'chat-b']);
    expect(second.adapter.stop).toHaveBeenCalledTimes(1);
    expect(gw.listBots().map((b) => b.botKey)).toEqual(['b1']);
  });

  it('aborts a wedged turn on timeout and AWAITS it before stopping the adapter', async () => {
    const { gw } = makeGateway();
    const second = capturingAdapter('test:b2');
    const wedged = wedgedLoop(30);
    // Record what the turn had done by the time the transport went away.
    let finishedAtStop = -1;
    (second.adapter.stop as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      finishedAtStop = wedged.state.finished;
    });
    gw.addAdapter(second.adapter, {
      botKey: 'b2',
      loop: wedged.loop,
      binding: { type: 'personality', name: 'b' },
    });

    second.deliver(message('b2'));
    await waitUntil(() => wedged.state.started > 0);

    // A turn that will never end on its own. The drain gives up, aborts it,
    // and then waits for the unwind.
    await gw.removeAdapter('b2', { drainTimeoutMs: 20 });

    expect(wedged.state.aborted).toBe(true);
    expect(wedged.state.finished).toBe(1);
    // THE ORDERING THIS TEST EXISTS FOR: stop() ran after the turn unwound,
    // not the instant the abort was raised.
    expect(finishedAtStop).toBe(1);
    expect(second.adapter.stop).toHaveBeenCalledTimes(1);
    expect(gw.listBots().map((b) => b.botKey)).toEqual(['b1']);
  });
});

// ---------------------------------------------------------------------------
// A drain that never completes must not be torn down anyway
// ---------------------------------------------------------------------------

describe('Gateway — a bot that will not drain is quarantined, not torn down', () => {
  it('refuses to finish the teardown while the cancellation is still running', async () => {
    const { gw, first } = makeGateway();
    const second = capturingAdapter('test:b2');
    // Unwinds long after the abort grace: the cancellation is still running
    // when the old code deleted the routing entry and stopped the transport.
    const wedged = wedgedLoop(400);
    gw.addAdapter(second.adapter, {
      botKey: 'b2',
      loop: wedged.loop,
      binding: { type: 'personality', name: 'b' },
    });

    second.deliver(message('b2'));
    await waitUntil(() => wedged.state.started > 0);

    await expect(gw.removeAdapter('b2', { drainTimeoutMs: 20, abortGraceMs: 20 })).rejects.toThrow(
      /still busy after the abort grace/,
    );

    // NOTHING was torn down: the turn still has the transport it is writing
    // to, the routing entry it was admitted under, and its loop wiring.
    expect(wedged.state.aborted).toBe(true);
    expect(wedged.state.finished).toBe(0);
    expect(second.adapter.stop).not.toHaveBeenCalled();
    expect(gw.listBots().map((b) => b.botKey)).toContain('b2');
    expect(gw.listAdapters()).toContain(second.adapter);
    // …but it is quarantined: no new inbound is admitted for it.
    second.deliver(message('b2', { chatId: 'chat-new', messageId: 'n1' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(wedged.state.started).toBe(1);
    // Every other bot is untouched.
    expect(first.adapter.stop).not.toHaveBeenCalled();
  });

  it('completes the teardown on a later retry, once the turn has unwound', async () => {
    const { gw } = makeGateway();
    const second = capturingAdapter('test:b2');
    const wedged = wedgedLoop(60);
    let finishedAtStop = -1;
    (second.adapter.stop as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      finishedAtStop = wedged.state.finished;
    });
    gw.addAdapter(second.adapter, {
      botKey: 'b2',
      loop: wedged.loop,
      binding: { type: 'personality', name: 'b' },
    });

    second.deliver(message('b2'));
    await waitUntil(() => wedged.state.started > 0);

    // Poll 1: the abort is raised, the grace expires, retirement is deferred.
    await expect(gw.removeAdapter('b2', { drainTimeoutMs: 10, abortGraceMs: 10 })).rejects.toThrow(
      /retirement deferred/,
    );
    expect(second.adapter.stop).not.toHaveBeenCalled();

    // Poll 2 — the reconciler retries because the unit is still in its applied
    // ledger. By now the aborted turn has unwound, so teardown completes.
    await waitUntil(() => wedged.state.finished === 1, 2000);
    await gw.removeAdapter('b2', { drainTimeoutMs: 200 });
    expect(second.adapter.stop).toHaveBeenCalledTimes(1);
    expect(finishedAtStop).toBe(1);
    expect(gw.listBots().map((b) => b.botKey)).toEqual(['b1']);
    expect(gw.listAdapters()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The clarify sweep is armed on the SETTING, not on the boot-time bridge list
// ---------------------------------------------------------------------------

describe('Gateway — clarify sweep reaches a hot-added bot', () => {
  it('sweeps a hot-added bot’s bridge even though none existed at construction', async () => {
    // Construction-time bots have no clarify bridge at all: the pre-fix gate
    // (`bridges.length > 0`) never created the timer, so the bot added below
    // was never swept for the life of the process.
    const gw = new Gateway({
      bots: [{ botKey: 'b1', loop: gatedLoop().loop, binding: { type: 'personality', name: 'a' } }],
      clarifySweepIntervalMs: 5,
    });

    const added = capturingAdapter('test:b2');
    const bridged = bridgedLoop();
    gw.addAdapter(added.adapter, {
      botKey: 'b2',
      loop: bridged.loop,
      binding: { type: 'personality', name: 'b' },
    });

    await waitUntil(() => bridged.sweep.mock.calls.length > 0);
    expect(bridged.sweep).toHaveBeenCalled();
    await gw.shutdown();
  });

  it('starts no sweep timer when sweeping is switched off', async () => {
    const gw = new Gateway({
      bots: [{ botKey: 'b1', loop: gatedLoop().loop, binding: { type: 'personality', name: 'a' } }],
      clarifySweepIntervalMs: 0,
    });
    const added = capturingAdapter('test:b2');
    const bridged = bridgedLoop();
    gw.addAdapter(added.adapter, {
      botKey: 'b2',
      loop: bridged.loop,
      binding: { type: 'personality', name: 'b' },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(bridged.sweep).not.toHaveBeenCalled();
    await gw.shutdown();
  });
});
