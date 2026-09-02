import type { DeliveryLedger } from '@ethosagent/delivery-ledger';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import type { DeliveryResult, OutboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { type DeliveryTargetConfig, relayToTargets } from '../webhook-relay';

// ---------------------------------------------------------------------------
// Phase 2 — webhook delivery fan-out.
//
// Same doctrine as `delivery-ledger.test.ts`: the property under test is not
// "we called send()", it is "the adapter said ok". Every case below either
// confirms or withholds that ok and asserts what the ledger did with the row.
//
// Plus the two properties this module adds on top of that: one target's
// failure or latency never touches a sibling, and the ledger `botKey` is the
// TARGET's adapterId — the boot sweep filters by the bots this process owns,
// so a `webhook:` botKey would never be swept.
// ---------------------------------------------------------------------------

const ledger = () => new SQLiteDeliveryLedger(':memory:');

/** Adapter whose send outcome is scriptable, plus a record of what it saw. */
function stubAdapter(
  id: string,
  opts: { ok?: boolean; throws?: boolean; gate?: Promise<void> } = {},
) {
  const sent: Array<{ chatId: string; message: OutboundMessage }> = [];
  const adapter = {
    id,
    displayName: id,
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (chatId: string, message: OutboundMessage): Promise<DeliveryResult> => {
      if (opts.gate) await opts.gate;
      if (opts.throws) throw new Error('socket hang up');
      sent.push({ chatId, message });
      return opts.ok === false ? { ok: false, error: 'platform rejected' } : { ok: true };
    }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter;
  return Object.assign(adapter, { sent });
}

function ctx(
  adapters: PlatformAdapter[],
  extra: { ledger?: DeliveryLedger; log?: (line: string) => void } = {},
) {
  return {
    hookId: 'hook1',
    sessionKey: 'webhook:hook1',
    adaptersById: new Map(adapters.map((a) => [a.id, a])),
    // `log` is required on the relay's ctx — the library never falls back to
    // `console`. Tests that assert on the lines pass their own collector.
    log: (_line: string) => {},
    ...extra,
  };
}

const platformTarget = (over: Partial<Extract<DeliveryTargetConfig, { type: 'platform' }>> = {}) =>
  ({ type: 'platform', adapterId: 'telegram:tg-a', chatId: 'chat-1', ...over }) as const;

describe('relayToTargets — log target', () => {
  it('succeeds and writes no ledger row (nothing to redeliver)', async () => {
    const store = ledger();
    const lines: string[] = [];
    const results = await relayToTargets([{ type: 'log' }], 'payload', {
      ...ctx([], { ledger: store }),
      log: (l: string) => lines.push(l),
    });

    expect(results).toEqual([{ target: { type: 'log' }, ok: true }]);
    expect(lines.join('\n')).toContain('hook1');
    expect(lines.join('\n')).toContain('payload');
    expect(await store.listRecent(10)).toHaveLength(0);
  });
});

describe('relayToTargets — platform target', () => {
  it('sends the right chatId/text/threadId and marks the row delivered', async () => {
    const store = ledger();
    const adapter = stubAdapter('telegram:tg-a');
    const results = await relayToTargets(
      [platformTarget({ threadId: 'thread-9' })],
      'the payload',
      ctx([adapter], { ledger: store }),
    );

    expect(results[0]?.ok).toBe(true);
    expect(adapter.sent).toEqual([
      { chatId: 'chat-1', message: { text: 'the payload', threadId: 'thread-9' } },
    ]);
    const rows = await store.listRecent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('delivered');
    expect(rows[0]?.threadId).toBe('thread-9');
    expect(rows[0]?.content).toBe('the payload');
  });

  it('records the ledger botKey as the TARGET adapterId, not webhook:<hookId>', async () => {
    const store = ledger();
    const adapter = stubAdapter('telegram:tg-a');
    await relayToTargets([platformTarget()], 'x', ctx([adapter], { ledger: store }));

    const rows = await store.listRecent(10);
    // The key correctness claim of this phase. `sweepPendingDeliveries` filters
    // pending obligations to the botKeys this process owns; `webhook:hook1`
    // matches no running bot and would never be redelivered.
    expect(rows[0]?.botKey).toBe('telegram:tg-a');
    expect(rows[0]?.platform).toBe('telegram');
    expect(rows[0]?.sessionId).toBe('webhook:hook1');
  });

  it('leaves the row pending when the adapter reports { ok: false }', async () => {
    const store = ledger();
    const adapter = stubAdapter('telegram:tg-a', { ok: false });
    const results = await relayToTargets(
      [platformTarget()],
      'x',
      ctx([adapter], { ledger: store }),
    );

    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toContain('platform rejected');
    expect(await store.listPending(['telegram:tg-a'])).toHaveLength(1);
  });

  it('leaves the row pending when send() throws', async () => {
    const store = ledger();
    const adapter = stubAdapter('telegram:tg-a', { throws: true });
    const results = await relayToTargets(
      [platformTarget()],
      'x',
      ctx([adapter], { ledger: store }),
    );

    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toContain('socket hang up');
    expect(await store.listPending(['telegram:tg-a'])).toHaveLength(1);
  });

  it('derives the platform from a non-namespaced adapter id', async () => {
    const store = ledger();
    const adapter = stubAdapter('email');
    await relayToTargets(
      [platformTarget({ adapterId: 'email' })],
      'x',
      ctx([adapter], { ledger: store }),
    );
    expect((await store.listRecent(10))[0]?.platform).toBe('email');
  });

  it('works with no ledger wired at all', async () => {
    const adapter = stubAdapter('telegram:tg-a');
    const results = await relayToTargets([platformTarget()], 'x', ctx([adapter]));
    expect(results[0]?.ok).toBe(true);
    expect(adapter.sent).toHaveLength(1);
  });
});

describe('relayToTargets — isolation between targets', () => {
  it('fails only the unknown adapterId; a sibling log target still succeeds', async () => {
    const store = ledger();
    const results = await relayToTargets(
      [platformTarget({ adapterId: 'telegram:gone' }), { type: 'log' }],
      'x',
      ctx([], { ledger: store }),
    );

    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toContain('telegram:gone');
    expect(results[1]?.ok).toBe(true);
    // An unresolvable target records nothing: there is no bot to sweep it.
    expect(await store.listRecent(10)).toHaveLength(0);
  });

  it('does not let a slow target block a fast sibling', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = stubAdapter('telegram:slow', { gate });
    const fast = stubAdapter('telegram:fast');

    const pending = relayToTargets(
      [
        platformTarget({ adapterId: 'telegram:slow', chatId: 'c-slow' }),
        platformTarget({ adapterId: 'telegram:fast', chatId: 'c-fast' }),
      ],
      'x',
      ctx([slow, fast]),
    );

    // Deterministic, not a timer race: the fast adapter has already been
    // called while the slow one is still parked on its gate.
    await vi.waitFor(() => expect(fast.sent).toHaveLength(1));
    expect(slow.sent).toHaveLength(0);

    release();
    const results = await pending;
    expect(results.map((r) => r.ok)).toEqual([true, true]);
  });
});

describe('relayToTargets — ledger failures never break a delivery', () => {
  it('still sends, reports ok, and surfaces the error through the injected log', async () => {
    const adapter = stubAdapter('telegram:tg-a');
    const lines: string[] = [];
    const brokenLedger = {
      record: vi.fn(async () => {
        throw new Error('disk full');
      }),
      listPending: vi.fn(async () => []),
      claim: vi.fn(async () => false),
      markDelivered: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
      get: vi.fn(async () => null),
      abandonStale: vi.fn(async () => []),
      pruneDelivered: vi.fn(async () => 0),
      stats: vi.fn(),
      listRecent: vi.fn(async () => []),
    } as unknown as DeliveryLedger;

    const results = await relayToTargets([platformTarget()], 'x', {
      ...ctx([adapter], { ledger: brokenLedger }),
      log: (l: string) => lines.push(l),
    });

    expect(results[0]?.ok).toBe(true);
    expect(adapter.sent).toHaveLength(1);
    expect(lines.join('\n')).toContain('disk full');
    expect(lines.join('\n')).toContain('record');
  });
});
