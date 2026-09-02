// The five code-review fixes to the live-reload reconciler, executed for real.
//
// `commands/boot.ts` imports `commands/serve.ts`, which imports
// `@ethosagent/acp-server` — an APP with no vitest alias, so boot.ts is not
// runtime-importable from a vitest run rooted at the repo. That is why the
// decisions these fixes turn on live in `config-reload.ts` as pure exported
// functions, and why they are driven here against real state rather than
// asserted against source. The boot-side wiring that hands them the gateway is
// asserted against source in `gateway-live-reload.test.ts`.

import { join } from 'node:path';
import { type EthosConfig, ethosDir, loadConfigStrict } from '@ethosagent/config';
import type { AgentLoop } from '@ethosagent/core';
import { Gateway } from '@ethosagent/gateway';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ClarifyResponse, InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import {
  appliedSliceFor,
  appliedStateOf,
  closeIdleRouteListener,
  commitHotAdd,
  createClarifyCorrelatorRegistry,
  createLiveBotBusySource,
  createReloadRunner,
  markApplied,
  markRetired,
  planReconcile,
  reconcilePending,
  replaceBotWiring,
  retireBotFully,
  shouldReloadConfig,
  swapBotLive,
} from '../config-reload';

const BASE = ['provider: anthropic', 'model: claude-a', 'apiKey: sk-x', 'personality: researcher'];

const telegram = (index: number, id: string, token: string) => [
  `telegram.bots.${index}.id: ${id}`,
  `telegram.bots.${index}.token: ${token}`,
  'channel_filter.telegram.ownerUserId: "1"',
  `telegram.bots.${index}.bind.type: personality`,
  `telegram.bots.${index}.bind.name: researcher`,
];

async function load(lines: string[]): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), `${lines.join('\n')}\n`);
  const loaded = await loadConfigStrict(storage);
  if (!loaded) throw new Error('loadConfigStrict returned null');
  return loaded.config;
}

// ---------------------------------------------------------------------------
// Finding 3 — a hot-add is a transaction
// ---------------------------------------------------------------------------

/**
 * A stand-in for the routing table with the SAME duplicate-botKey guard
 * `Gateway.addAdapter` enforces — the guard a failed hot-add used to strand the
 * next attempt on.
 */
function fakeRoutingTable() {
  const bots = new Set<string>();
  const running = new Set<string>();
  return {
    bots,
    running,
    add(botKey: string): void {
      if (bots.has(botKey)) {
        throw new Error(`Gateway: botKey "${botKey}" is already registered.`);
      }
      bots.add(botKey);
    },
    async remove(botKey: string): Promise<void> {
      bots.delete(botKey);
      running.delete(botKey);
    },
  };
}

/** The steps a hot-add is made of, with each failure point switchable. */
function hotAddSteps(
  table: ReturnType<typeof fakeRoutingTable>,
  botKey: string,
  fail: { wire?: boolean; start?: boolean } = {},
) {
  const state = { wired: false, mounted: false, rollbackErrors: [] as unknown[] };
  const steps = {
    register: () => table.add(botKey),
    wire: async () => {
      if (fail.wire) throw new Error('wiring blew up');
      state.wired = true;
      return async () => {
        state.wired = false;
      };
    },
    start: async () => {
      if (fail.start) throw new Error('adapter refused to start');
      table.running.add(botKey);
      state.mounted = true;
    },
    unmount: () => {
      state.mounted = false;
    },
    deregister: () => table.remove(botKey),
    onRollbackError: (err: unknown) => {
      state.rollbackErrors.push(err);
    },
  };
  return { steps, state };
}

describe('commitHotAdd — a failed hot-add leaves nothing behind', () => {
  it('unwinds the routing-table entry, the wiring and the mount when start fails', async () => {
    const table = fakeRoutingTable();
    const { steps, state } = hotAddSteps(table, 'b1', { start: true });

    await expect(commitHotAdd(steps)).rejects.toThrow('adapter refused to start');

    expect([...table.bots]).toEqual([]);
    expect([...table.running]).toEqual([]);
    expect(state.wired).toBe(false);
    expect(state.mounted).toBe(false);
    expect(state.rollbackErrors).toEqual([]);
  });

  it('unwinds the routing-table entry when the WIRING fails, before any start', async () => {
    const table = fakeRoutingTable();
    const { steps, state } = hotAddSteps(table, 'b1', { wire: true });

    await expect(commitHotAdd(steps)).rejects.toThrow('wiring blew up');

    expect([...table.bots]).toEqual([]);
    expect(state.mounted).toBe(false);
  });

  it('lets the NEXT poll retry successfully instead of hitting the duplicate guard', async () => {
    const table = fakeRoutingTable();
    const first = hotAddSteps(table, 'b1', { start: true });
    await expect(commitHotAdd(first.steps)).rejects.toThrow('adapter refused to start');

    // The retry the applied-state ledger owes. Before the fix this threw
    // `botKey "b1" is already registered` and the bot could never come up.
    const second = hotAddSteps(table, 'b1');
    const undoWiring = await commitHotAdd(second.steps);

    expect([...table.bots]).toEqual(['b1']);
    expect([...table.running]).toEqual(['b1']);
    expect(second.state.wired).toBe(true);

    // And the handle it hands back really is the wiring's undo.
    await undoWiring();
    expect(second.state.wired).toBe(false);
  });

  it('reports a rollback step that itself fails, and still throws the original', async () => {
    const table = fakeRoutingTable();
    const { steps, state } = hotAddSteps(table, 'b1', { start: true });
    steps.unmount = () => {
      throw new Error('unmount exploded');
    };

    await expect(commitHotAdd(steps)).rejects.toThrow('adapter refused to start');
    expect(state.rollbackErrors.map((e) => (e as Error).message)).toEqual(['unmount exploded']);
    // The rest of the rollback still ran.
    expect([...table.bots]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Finding 2 — a `changed` bot's replacement is built before the old is retired,
// and a failed replacement rolls back by BUILDING a fresh one
// ---------------------------------------------------------------------------

/**
 * The bot lifecycle a swap actually runs against, with the one property the
 * review turns on made explicit: an adapter that has been stopped is DEAD.
 *
 * `PlatformAdapter` promises nothing about `start()` after `stop()` — real
 * transports destroy their client, socket, listeners or auth state — so this
 * throws, and any rollback that re-registers the retired object fails here
 * rather than passing by accident.
 */
function botLifecycle() {
  const log: string[] = [];
  let serial = 0;
  const adapters = new Map<string, { id: string; starts: number; stops: number }>();
  let live: string | undefined;

  const build = (label: string): string => {
    const id = `${label}#${++serial}`;
    adapters.set(id, { id, starts: 0, stops: 0 });
    log.push(`build ${id}`);
    return id;
  };
  const start = (id: string): void => {
    const a = adapters.get(id);
    if (!a) throw new Error(`${id}: never built`);
    if (a.stops > 0) throw new Error(`${id}: start() after stop() — this adapter is dead`);
    a.starts++;
    live = id;
    log.push(`start ${id}`);
  };
  const stop = (): void => {
    if (!live) return;
    const a = adapters.get(live);
    if (a) a.stops++;
    log.push(`stop ${live}`);
    live = undefined;
  };
  return {
    log,
    build,
    start,
    stop,
    adapter: (id: string) => adapters.get(id),
    liveAdapter: () => live,
    /** Every adapter object ever built, in build order. */
    builtIds: () => [...adapters.keys()],
  };
}

describe('swapBotLive — a rejected edit is not an outage', () => {
  it('leaves the old bot serving when the replacement cannot even be BUILT', async () => {
    const h = botLifecycle();
    h.start(h.build('cold'));
    h.log.length = 0;

    await expect(
      swapBotLive<string>({
        prepare: async () => {
          throw new Error('no channel_filter.telegram entry (add one, then re-save)');
        },
        retire: async () => h.stop(),
        commit: async (id) => h.start(id),
        rebuildPrevious: async () => h.build('previous'),
        onRestoreFailed: () => {},
      }),
    ).rejects.toThrow('no channel_filter.telegram entry');

    // Nothing was retired: the old adapter never stopped serving.
    expect(h.liveAdapter()).toBe('cold#1');
    expect(h.log).toEqual([]);
  });

  it('rolls back by BUILDING a fresh instance, never by restarting the stopped one', async () => {
    const h = botLifecycle();
    h.start(h.build('cold'));
    h.log.length = 0;
    const reported: string[] = [];

    await expect(
      swapBotLive<string>({
        prepare: async () => h.build('replacement'),
        retire: async () => h.stop(),
        commit: async (id) => {
          // The edit is bad: the new credentials are refused by the platform.
          if (id.startsWith('replacement')) throw new Error('adapter refused to start');
          h.start(id);
        },
        rebuildPrevious: async () => h.build('previous'),
        onRestoreFailed: (err) => reported.push((err as Error).message),
      }),
    ).rejects.toThrow('adapter refused to start');

    // THE ASSERTION THIS TEST EXISTS FOR: the retired object was stopped once
    // and never started again. `botLifecycle.start` throws on a stopped
    // adapter, so a rollback that re-registered `cold#1` would have surfaced
    // here as a rollback failure — `reported` stays empty because the rollback
    // built a THIRD adapter and put that one through the same commit.
    expect(h.adapter('cold#1')).toEqual({ id: 'cold#1', starts: 1, stops: 1 });
    expect(reported).toEqual([]);
    expect(h.liveAdapter()).toBe('previous#3');
    expect(h.log).toEqual([
      'build replacement#2',
      'stop cold#1',
      'build previous#3',
      'start previous#3',
    ]);
  });

  it('surfaces the dead-adapter error if a rollback ever restarts the retired one', async () => {
    // The shape of the defect, driven directly: this is what the OLD rollback
    // did — re-register the object `retire` had just stopped — and what a real
    // transport answers with. It is here so the guard in `botLifecycle` above
    // is provably load-bearing rather than decorative.
    const h = botLifecycle();
    const cold = h.build('cold');
    h.start(cold);
    h.stop();
    expect(() => h.start(cold)).toThrow('start() after stop() — this adapter is dead');
  });

  it('reports a rollback that also fails, and still throws the commit error', async () => {
    const h = botLifecycle();
    h.start(h.build('cold'));
    const reported: string[] = [];

    await expect(
      swapBotLive<string>({
        prepare: async () => h.build('replacement'),
        retire: async () => h.stop(),
        commit: async (id) => {
          if (id.startsWith('replacement')) throw new Error('adapter refused to start');
          h.start(id);
        },
        rebuildPrevious: async () => {
          throw new Error('and the previous config would not build either');
        },
        onRestoreFailed: (err) => reported.push((err as Error).message),
      }),
    ).rejects.toThrow('adapter refused to start');

    expect(reported).toEqual(['and the previous config would not build either']);
  });

  it('swaps cleanly when the replacement commits, and never rebuilds', async () => {
    const h = botLifecycle();
    h.start(h.build('cold'));
    let rebuilt = 0;

    await swapBotLive<string>({
      prepare: async () => h.build('replacement'),
      retire: async () => h.stop(),
      commit: async (id) => h.start(id),
      rebuildPrevious: async () => {
        rebuilt++;
        return h.build('previous');
      },
      onRestoreFailed: () => {},
    });

    expect(h.liveAdapter()).toBe('replacement#2');
    expect(rebuilt).toBe(0);
    expect(h.builtIds()).toEqual(['cold#1', 'replacement#2']);
  });
});

// ---------------------------------------------------------------------------
// Finding 2 (second half) — cold-booted and hot-added bots share ONE registry
// ---------------------------------------------------------------------------

describe('replaceBotWiring — a replaced bot\u2019s wiring is torn down exactly once', () => {
  /** A teardown handle that records that it ran, and how often. */
  function handle(tag: string, log: string[]) {
    const state = { runs: 0 };
    return {
      state,
      teardown: async () => {
        state.runs++;
        log.push(`teardown ${tag}`);
      },
    };
  }

  it('runs the outgoing handle AFTER the replacement has taken the slot', async () => {
    const log: string[] = [];
    const registry = new Map<string, () => Promise<void>>();
    // Seeded by cold boot — the case that used to find nothing to run.
    const cold = handle('cold', log);
    registry.set('b1', cold.teardown);

    const next = handle('replacement', log);
    await replaceBotWiring(registry, 'b1', next.teardown);

    expect(cold.state.runs).toBe(1);
    expect(next.state.runs).toBe(0);
    expect(registry.get('b1')).toBe(next.teardown);
    expect(log).toEqual(['teardown cold']);
  });

  it('does not accumulate across repeated replacements', async () => {
    const log: string[] = [];
    const registry = new Map<string, () => Promise<void>>();
    const handles = [handle('v0', log)];
    registry.set('b1', handles[0]?.teardown ?? (async () => {}));

    for (let i = 1; i <= 5; i++) {
      const next = handle(`v${i}`, log);
      handles.push(next);
      await replaceBotWiring(registry, 'b1', next.teardown);
      // One live handle per bot, forever — never a second set beside the first.
      expect(registry.size).toBe(1);
    }

    // Every superseded handle ran exactly once; the current one has not run.
    expect(handles.slice(0, 5).map((h) => h.state.runs)).toEqual([1, 1, 1, 1, 1]);
    expect(handles[5]?.state.runs).toBe(0);
    expect(log).toEqual([
      'teardown v0',
      'teardown v1',
      'teardown v2',
      'teardown v3',
      'teardown v4',
    ]);
  });

  it('is a plain registration when the bot has no wiring yet (a hot add)', async () => {
    const registry = new Map<string, () => Promise<void>>();
    const next = handle('added', []);
    await replaceBotWiring(registry, 'b2', next.teardown);
    expect(registry.get('b2')).toBe(next.teardown);
    expect(next.state.runs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A DEFERRED retirement leaves the bot fully wired — transport before wiring
// ---------------------------------------------------------------------------

/** An adapter that hands back the handler the gateway wires into it. */
function testAdapter(id: string) {
  let handler: ((m: InboundMessage) => void) | undefined;
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
    send: vi.fn().mockResolvedValue({ ok: true, messageId: 'm1' }),
    onMessage: vi.fn((h: (m: InboundMessage) => void) => {
      handler = h;
    }),
    health: vi.fn().mockResolvedValue({ ok: true }),
  };
  return {
    adapter,
    deliver: (msg: InboundMessage) => {
      if (!handler) throw new Error(`${id}: nothing wired onMessage`);
      handler(msg);
    },
  };
}

/** A turn that ignores its gate and only unwinds `unwindMs` after its abort. */
function wedgedLoop(unwindMs: number) {
  const state = { started: 0, aborted: false, finished: 0 };
  const loop = {
    run: vi.fn(async function* (_text: string, opts: { abortSignal: AbortSignal }) {
      state.started++;
      await new Promise<void>((resolve) => {
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

function wedgedInbound(botKey: string): InboundMessage {
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
  };
}

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('retireBotFully — a quarantined bot keeps ALL of its wiring', () => {
  it('leaves every per-bot registration installed until a later retry succeeds', async () => {
    // A REAL gateway, and a real deferral: the bot's turn ignores the drain
    // timeout and is still unwinding when the abort grace expires, which is
    // exactly when `removeAdapter` quarantines instead of tearing down.
    const idle = testAdapter('test:b1');
    const gw = new Gateway({
      bots: [
        {
          botKey: 'b1',
          loop: { run: vi.fn(), hooks: { registerVoid: vi.fn(() => () => {}) } } as never,
          binding: { type: 'personality', name: 'a' },
        },
      ],
      botAdapters: new Map([['b1', idle.adapter]]),
      adapters: new Map([['test', idle.adapter]]),
    });

    const busy = testAdapter('test:b2');
    const wedged = wedgedLoop(80);
    gw.addAdapter(busy.adapter, {
      botKey: 'b2',
      loop: wedged.loop,
      binding: { type: 'personality', name: 'b' },
    });
    busy.adapter.onMessage((m) => void gw.handleMessage(m, busy.adapter));

    // The app-level half `boot.ts` holds per bot: routers, clarify correlator,
    // approval surface, messaging bindings, personality refreshers — one
    // teardown handle, in the one registry.
    const registry = new Map<string, () => Promise<void>>();
    const teardown = { runs: 0 };
    const handle = async () => {
      teardown.runs++;
    };
    registry.set('b2', handle);

    busy.deliver(wedgedInbound('b2'));
    await waitUntil(() => wedged.state.started > 0);

    // Poll 1 — the drain times out, the abort is raised, the grace expires,
    // and retirement is DEFERRED.
    await expect(
      retireBotFully(registry, 'b2', () =>
        gw.removeAdapter('b2', { drainTimeoutMs: 10, abortGraceMs: 10 }),
      ),
    ).rejects.toThrow(/retirement deferred/);

    // The bot is quarantined — so it must still BE a bot. Transport intact…
    expect(busy.adapter.stop).not.toHaveBeenCalled();
    expect(gw.listBots().map((b) => b.botKey)).toContain('b2');
    // …and, the point of this test, its app-level wiring intact too: the turn
    // that is still unwinding keeps the approval flow, correlator, routers and
    // messaging bindings it was admitted with.
    expect(teardown.runs).toBe(0);
    expect(registry.get('b2')).toBe(handle);

    // Poll 2 — the reconciler retries because the unit never left its applied
    // ledger. The turn has unwound by now, so the teardown completes.
    await waitUntil(() => wedged.state.finished === 1);
    await retireBotFully(registry, 'b2', () => gw.removeAdapter('b2', { drainTimeoutMs: 500 }));

    expect(busy.adapter.stop).toHaveBeenCalledTimes(1);
    expect(gw.listBots().map((b) => b.botKey)).toEqual(['b1']);
    // Exactly once, and the handle is gone — a third poll has nothing to run.
    expect(teardown.runs).toBe(1);
    expect(registry.has('b2')).toBe(false);
    await retireBotFully(registry, 'b2', () => gw.removeAdapter('b2'));
    expect(teardown.runs).toBe(1);
  });

  it('does not run the teardown when the transport retire fails for any reason', async () => {
    const registry = new Map<string, () => Promise<void>>();
    const teardown = { runs: 0 };
    registry.set('b1', async () => {
      teardown.runs++;
    });
    await expect(
      retireBotFully(registry, 'b1', () => Promise.reject(new Error('deferred'))),
    ).rejects.toThrow('deferred');
    expect(teardown.runs).toBe(0);
    expect(registry.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Finding 3 — the idle watcher folds the LIVE bot list, with no static half
// ---------------------------------------------------------------------------

describe('createLiveBotBusySource — a replaced bot\u2019s work is still counted', () => {
  /** A bot's two background handles, with a settable amount of live work. */
  function bot(active: number) {
    return {
      jobStore: { countActive: async () => active },
      backgroundExecutor: { activeCount: () => active },
    };
  }

  it('reports busy for a REPLACED cold-boot bot with work in flight', async () => {
    // `b1` was present at cold boot. It is replaced: same botKey, new stores.
    const live = [bot(0)];
    const source = createLiveBotBusySource(() => live);
    expect(await source.jobStore.countActive()).toBe(0);
    expect(source.backgroundExecutor.activeCount()).toBe(0);

    // The replacement is registered under the SAME botKey and starts a job.
    // A scheme that split "static at cold boot" from "added since" by botKey
    // put this bot in neither half and reported idle here.
    live[0] = bot(3);
    expect(await source.jobStore.countActive()).toBe(3);
    expect(source.backgroundExecutor.activeCount()).toBe(3);
  });

  it('sums every live bot and drops the ones that left', async () => {
    const live = [bot(1), bot(2)];
    const source = createLiveBotBusySource(() => live);
    expect(await source.jobStore.countActive()).toBe(3);
    expect(source.backgroundExecutor.activeCount()).toBe(3);

    live.pop();
    expect(await source.jobStore.countActive()).toBe(1);
    expect(source.backgroundExecutor.activeCount()).toBe(1);
  });

  it('tolerates a bot with no background subsystem at all', async () => {
    const source = createLiveBotBusySource(() => [{}, bot(2)]);
    expect(await source.jobStore.countActive()).toBe(2);
    expect(source.backgroundExecutor.activeCount()).toBe(2);
  });

  it('is empty, not busy, when the gateway has no bots', async () => {
    const source = createLiveBotBusySource(() => []);
    expect(await source.jobStore.countActive()).toBe(0);
    expect(source.backgroundExecutor.activeCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Finding 1 — the applied snapshot advances per unit, not per parse
// ---------------------------------------------------------------------------

describe('applied-state ledger — a failed reconcile stays pending', () => {
  it('plans nothing for the config the process booted on', async () => {
    const cfg = await load([...BASE, ...telegram(0, 'alpha', '111:AAA')]);
    const applied = appliedStateOf(cfg);
    const plan = planReconcile(applied, cfg);
    expect(plan.bots).toEqual({ added: [], removed: [], changed: [] });
    expect(reconcilePending(applied, cfg)).toBe(false);
  });

  it('keeps a failed add pending, and applies it on a later retry', async () => {
    const booted = await load([...BASE, ...telegram(0, 'alpha', '111:AAA')]);
    const edited = await load([
      ...BASE,
      ...telegram(0, 'alpha', '111:AAA'),
      ...telegram(1, 'beta', '222:BBB'),
    ]);
    const applied = appliedStateOf(booted);

    // Poll 1: the add is planned and FAILS, so nothing is marked.
    expect(planReconcile(applied, edited).bots.added).toEqual(['telegram:beta']);
    expect(reconcilePending(applied, edited)).toBe(true);

    // Poll 2, file untouched: the mtime gate must not suppress the retry.
    expect(
      shouldReloadConfig({
        mtimeMs: 42,
        lastMtimeMs: 42,
        pending: reconcilePending(applied, edited),
      }),
    ).toBe(true);
    expect(planReconcile(applied, edited).bots.added).toEqual(['telegram:beta']);

    // Poll 2 succeeds.
    markApplied(applied, edited, 'bot', 'telegram:beta');
    expect(reconcilePending(applied, edited)).toBe(false);
    expect(
      shouldReloadConfig({
        mtimeMs: 42,
        lastMtimeMs: 42,
        pending: reconcilePending(applied, edited),
      }),
    ).toBe(false);
  });

  it('does not re-apply the units that already succeeded alongside a failure', async () => {
    const booted = await load([...BASE, ...telegram(0, 'alpha', '111:AAA')]);
    const edited = await load([
      ...BASE,
      ...telegram(0, 'alpha', '111:AAA'),
      ...telegram(1, 'beta', '222:BBB'),
      'webhooks.hook1.personalityId: researcher',
      'webhooks.hook1.secret: s1',
    ]);
    const applied = appliedStateOf(booted);

    // The webhook applied; the bot did not.
    markApplied(applied, edited, 'webhook', 'hook1');
    const plan = planReconcile(applied, edited);
    expect(plan.webhooks).toEqual({ added: [], removed: [], changed: [] });
    expect(plan.bots.added).toEqual(['telegram:beta']);
  });

  it('re-plans a bot whose entry changed again while it was still pending', async () => {
    const booted = await load([...BASE, ...telegram(0, 'alpha', '111:AAA')]);
    const v1 = await load([
      ...BASE,
      ...telegram(0, 'alpha', '111:AAA'),
      ...telegram(1, 'b', '2:B'),
    ]);
    const applied = appliedStateOf(booted);
    markApplied(applied, v1, 'bot', 'telegram:b');

    const v2 = await load([
      ...BASE,
      ...telegram(0, 'alpha', '111:AAA'),
      ...telegram(1, 'b', '3:C'),
    ]);
    expect(planReconcile(applied, v2).bots.changed).toEqual(['telegram:b']);
  });

  it('plans a removal, and stops planning it once it is retired', async () => {
    const booted = await load([
      ...BASE,
      ...telegram(0, 'alpha', '111:AAA'),
      ...telegram(1, 'beta', '222:BBB'),
    ]);
    const edited = await load([...BASE, ...telegram(0, 'alpha', '111:AAA')]);
    const applied = appliedStateOf(booted);

    expect(planReconcile(applied, edited).bots.removed).toEqual(['telegram:beta']);
    markRetired(applied, 'bot', 'telegram:beta');
    expect(reconcilePending(applied, edited)).toBe(false);
  });

  it('never gates on an unknown mtime', () => {
    expect(shouldReloadConfig({ mtimeMs: null, lastMtimeMs: null, pending: false })).toBe(true);
    expect(shouldReloadConfig({ mtimeMs: 7, lastMtimeMs: 7, pending: false })).toBe(false);
    expect(shouldReloadConfig({ mtimeMs: 8, lastMtimeMs: 7, pending: false })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Finding 4 — clarify correlators are keyed, not appended
// ---------------------------------------------------------------------------

function inbound(text: string): InboundMessage {
  return {
    platform: 'telegram',
    chatId: 'c1',
    userId: 'u1',
    text,
    isDm: true,
    isGroupMention: false,
    messageId: 'm1',
    raw: {},
  };
}

/** A correlator that always answers, tagged so the winner is identifiable. */
function answering(tag: string) {
  const calls: string[] = [];
  const correlate = async (msg: InboundMessage): Promise<ClarifyResponse | null> => {
    calls.push(msg.text ?? '');
    return { requestId: tag, answer: tag } as unknown as ClarifyResponse;
  };
  return { correlate, calls };
}

describe('clarify correlator registry — removal drops the closure', () => {
  it('drops a removed bot’s correlator and gives a re-added bot a fresh one', async () => {
    const registry = createClarifyCorrelatorRegistry();
    const first = answering('bot-a-v1');
    registry.set('a', first.correlate);
    expect(registry.size()).toBe(1);

    // The bot is removed — its closure over the now-dead adapter goes with it.
    registry.delete('a');
    expect(registry.size()).toBe(0);
    expect(await registry.correlate(inbound('while absent'))).toBeNull();
    expect(first.calls).toEqual([]);

    // Re-added: the fresh correlator answers, and the stale one never runs.
    const second = answering('bot-a-v2');
    registry.set('a', second.correlate);
    const resp = await registry.correlate(inbound('after re-add'));
    expect((resp as unknown as { answer: string }).answer).toBe('bot-a-v2');
    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual(['after re-add']);
  });

  it('does not accumulate a correlator per reload', () => {
    const registry = createClarifyCorrelatorRegistry();
    for (let i = 0; i < 5; i++) {
      registry.set('a', answering(`v${i}`).correlate);
      registry.delete('a');
    }
    expect(registry.size()).toBe(0);
  });

  it('deletes only its own correlator, never the one that replaced it', async () => {
    const registry = createClarifyCorrelatorRegistry();
    const outgoing = answering('old');
    const incoming = answering('new');
    registry.set('a', outgoing.correlate);
    // A swap registers the replacement first, then runs the retiring
    // instance's teardown — which must not delete what just replaced it.
    registry.set('a', incoming.correlate);
    registry.delete('a', outgoing.correlate);
    expect(registry.size()).toBe(1);
    const resp = await registry.correlate(inbound('hi'));
    expect((resp as unknown as { answer: string }).answer).toBe('new');
  });

  it('falls through a correlator that has nothing to say', async () => {
    const registry = createClarifyCorrelatorRegistry();
    registry.set('a', async () => null);
    const b = answering('b');
    registry.set('b', b.correlate);
    const resp = await registry.correlate(inbound('hi'));
    expect((resp as unknown as { answer: string }).answer).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// The rollback source is the APPLIED slice, not the previously parsed file
// ---------------------------------------------------------------------------

describe('applied slices — a rollback rebuilds what was RUNNING', () => {
  const A = [...BASE, ...telegram(0, 'b', '1:AAA')];
  const B = [...BASE, ...telegram(0, 'b', '2:BBB')];
  const C = [...BASE, ...telegram(0, 'b', '3:CCC')];

  it('seeds a slice per unit from the config the process cold-booted', async () => {
    const booted = await load([
      ...A,
      'webhooks.hook1.personalityId: researcher',
      'webhooks.hook1.secret: s1',
    ]);
    const applied = appliedStateOf(booted);
    expect(appliedSliceFor(applied, 'bot', 'telegram:b')?.telegram?.bots[0]?.token).toBe('1:AAA');
    expect(Object.keys(appliedSliceFor(applied, 'webhook', 'hook1')?.webhooks ?? {})).toEqual([
      'hook1',
    ]);
    // A slice carries ONE unit, so it feeds straight back into the same
    // prepare/build path a hot-add uses.
    expect(appliedSliceFor(applied, 'bot', 'telegram:b')?.telegram?.bots).toHaveLength(1);
    expect(appliedSliceFor(applied, 'bot', 'telegram:b')?.webhooks).toBeUndefined();
  });

  // THE DIVERGENCE THIS FIXES. A is running. B parses but the bot fails to
  // apply. C is then saved and its replacement fails too. The old rollback
  // source — "the previously parsed config" — is B, a version that was never
  // live; the ledger still says A. They have to be the same record.
  it('rolls back to A when B failed and C was saved on top of it', async () => {
    const a = await load(A);
    const b = await load(B);
    const c = await load(C);
    const applied = appliedStateOf(a);

    // Poll 1: B is planned, the bot fails, nothing is marked applied.
    expect(planReconcile(applied, b).bots.changed).toEqual(['telegram:b']);
    // Poll 2: C is on disk now and is what the plan targets.
    expect(planReconcile(applied, c).bots.changed).toEqual(['telegram:b']);

    // The rollback source is still A — the version actually running.
    const rollback = appliedSliceFor(applied, 'bot', 'telegram:b');
    expect(rollback?.telegram?.bots[0]?.token).toBe('1:AAA');

    // Driven through the real swap, the restored instance carries A's token.
    const built: string[] = [];
    await expect(
      swapBotLive<string>({
        prepare: async () => c.telegram?.bots[0]?.token ?? '',
        retire: async () => {},
        commit: async (token) => {
          if (token === (c.telegram?.bots[0]?.token ?? '')) throw new Error('commit refused');
          built.push(token);
        },
        rebuildPrevious: async () =>
          appliedSliceFor(applied, 'bot', 'telegram:b')?.telegram?.bots[0]?.token ?? '',
        onRestoreFailed: () => {
          throw new Error('the restore should have succeeded');
        },
      }),
    ).rejects.toThrow('commit refused');
    expect(built).toEqual(['1:AAA']);
    expect(built).not.toContain('2:BBB');
  });

  it('advances the slice only on a successful commit, and drops it on retirement', async () => {
    const a = await load(A);
    const c = await load(C);
    const applied = appliedStateOf(a);
    markApplied(applied, c, 'bot', 'telegram:b');
    expect(appliedSliceFor(applied, 'bot', 'telegram:b')?.telegram?.bots[0]?.token).toBe('3:CCC');
    markRetired(applied, 'bot', 'telegram:b');
    expect(appliedSliceFor(applied, 'bot', 'telegram:b')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Shutdown must not race a reconcile that is already running
// ---------------------------------------------------------------------------

describe('createReloadRunner', () => {
  /** A reconcile is not supposed to throw in these cases — fail loudly if one does. */
  const unexpected = (err: unknown): never => {
    throw err instanceof Error ? err : new Error(String(err));
  };

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve = (): void => {};
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it('awaits the reconcile in flight before stop() resolves', async () => {
    const gate = deferred();
    let finished = false;
    const runner = createReloadRunner(async () => {
      await gate.promise;
      finished = true;
    }, unexpected);

    runner.trigger();
    const stopped = { done: false };
    const stopping = runner.stop().then(() => {
      stopped.done = true;
    });

    // The reconcile is still adding bots / rebinding servers: shutdown may not
    // proceed to tear those same resources down.
    await new Promise((r) => setTimeout(r, 10));
    expect(stopped.done).toBe(false);
    expect(finished).toBe(false);

    gate.resolve();
    await stopping;
    expect(stopped.done).toBe(true);
    expect(finished).toBe(true);
  });

  it('refuses every reconcile once stop() has begun', async () => {
    const gate = deferred();
    let runs = 0;
    const runner = createReloadRunner(async () => {
      runs++;
      await gate.promise;
    }, unexpected);

    runner.trigger();
    const stopping = runner.stop();
    // A poll that fires during the shutdown drain must not start a new one.
    runner.trigger();
    gate.resolve();
    await stopping;
    runner.trigger();
    await new Promise((r) => setTimeout(r, 5));
    expect(runs).toBe(1);
  });

  it('never overlaps two reconciles, and stop() is safe with none running', async () => {
    const gate = deferred();
    let runs = 0;
    const runner = createReloadRunner(async () => {
      runs++;
      await gate.promise;
    }, unexpected);
    runner.trigger();
    runner.trigger();
    expect(runs).toBe(1);
    gate.resolve();
    await runner.stop();
    await expect(runner.stop()).resolves.toBeUndefined();
  });

  it('hands a throwing reconcile to onError rather than rejecting stop()', async () => {
    const seen: unknown[] = [];
    const runner = createReloadRunner(async () => {
      throw new Error('reconcile blew up');
    }, seen.push.bind(seen));
    runner.trigger();
    await expect(runner.stop()).resolves.toBeUndefined();
    expect((seen[0] as Error).message).toBe('reconcile blew up');
  });
});

// ---------------------------------------------------------------------------
// An on-demand bind owes an on-demand unbind
// ---------------------------------------------------------------------------

describe('closeIdleRouteListener', () => {
  function listener() {
    const state = { closed: 0 };
    return { state, close: () => state.closed++ };
  }

  it('closes and clears the handle when the last route is gone', () => {
    const server = listener();
    const next = closeIdleRouteListener({
      server,
      routeCount: 0,
      close: (s) => s.close(),
    });
    expect(next).toBeUndefined();
    expect(server.state.closed).toBe(1);
  });

  it('keeps the listener while any route remains', () => {
    const server = listener();
    const next = closeIdleRouteListener({ server, routeCount: 1, close: (s) => s.close() });
    expect(next).toBe(server);
    expect(server.state.closed).toBe(0);
  });

  it('is a no-op when nothing is bound', () => {
    let closed = 0;
    expect(
      closeIdleRouteListener<{ close(): void }>({
        server: undefined,
        routeCount: 0,
        close: () => {
          closed++;
        },
      }),
    ).toBeUndefined();
    expect(closed).toBe(0);
  });

  it('lets a later addition bind again — the point of clearing the handle', () => {
    const first = listener();
    let held = closeIdleRouteListener<ReturnType<typeof listener>>({
      server: first,
      routeCount: 0,
      close: (s) => s.close(),
    });
    expect(held).toBeUndefined();
    // `ensureWebhookServer`'s gate is `if (server) return`, so a cleared
    // handle is exactly what allows the rebind.
    const second = listener();
    held ??= second;
    expect(held).toBe(second);
  });
});
