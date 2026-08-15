// `Gateway.notifyTracked` — the public door onto the delivery ledger.
//
// The post-call summary and the owner's "a call was refused for capacity"
// notice have nobody waiting on them, so "the send silently failed" is the
// failure mode that matters (voice V4: "so a summary is never silently lost").
// `sendTo()` cannot serve them: it records no obligation. `sendTracked()` could,
// but it was private.
//
// The property under test is the ledger's, not the API's: an unconfirmed send
// leaves a `pending` row that the boot sweep redelivers. Same definition of
// confirmed as every other covered path — `DeliveryResult.ok === true`.

import { type AgentLoop, DefaultHookRegistry } from '@ethosagent/core';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import type { DeliveryResult, OutboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';

function stubAdapter(opts: { ok?: boolean } = {}) {
  const sent: Array<{ chatId: string; message: OutboundMessage }> = [];
  let nextId = 1;
  const adapter = {
    id: 'telegram:test',
    displayName: 'Telegram',
    capabilities: { platform: 'telegram' },
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (chatId: string, message: OutboundMessage): Promise<DeliveryResult> => {
      sent.push({ chatId, message });
      return opts.ok === false
        ? { ok: false, error: 'platform rejected the message' }
        : { ok: true, messageId: String(nextId++) };
    }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter;
  return Object.assign(adapter, { sent });
}

function stubLoop(): AgentLoop {
  return {
    run: vi.fn(async function* () {
      yield { type: 'done' as const, text: '', turnCount: 1 };
    }),
    hooks: new DefaultHookRegistry(),
  } as unknown as AgentLoop;
}

function gatewayWith(opts: {
  ledger?: SQLiteDeliveryLedger;
  adapters?: Map<string, PlatformAdapter>;
  botKeys?: string[];
  observability?: { recordSafetyBlock: (e: { code: string; cause: string }) => void };
}) {
  return new Gateway({
    bots: (opts.botKeys ?? ['bot-a']).map((botKey) => ({
      botKey,
      loop: stubLoop(),
      binding: { type: 'personality' as const, name: 'default' },
    })),
    ...(opts.ledger ? { deliveryLedger: opts.ledger } : {}),
    ...(opts.adapters ? { adapters: opts.adapters } : {}),
    ...(opts.observability ? { observability: opts.observability as unknown as never } : {}),
    clarifySweepIntervalMs: 0,
  });
}

const TARGET = { platform: 'telegram', chatId: 'C1' };

describe('Gateway.notifyTracked', () => {
  it('confirms a delivered notice and leaves no obligation behind', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const adapter = stubAdapter();
    const gw = gatewayWith({ ledger, adapters: new Map([['telegram', adapter]]) });

    await expect(gw.notifyTracked(TARGET, 'call summary')).resolves.toBe(true);

    expect(adapter.sent.map((s) => s.message.text)).toEqual(['call summary']);
    expect(await ledger.listPending(['bot-a'])).toHaveLength(0);
  });

  // The whole reason this method exists.
  it('a failing adapter leaves the row pending and the boot sweep redelivers it', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const failing = stubAdapter({ ok: false });
    const gw = gatewayWith({ ledger, adapters: new Map([['telegram', failing]]) });

    await expect(gw.notifyTracked(TARGET, 'call summary')).resolves.toBe(false);

    const pending = await ledger.listPending(['bot-a']);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe('pending');
    expect(pending[0]?.content).toBe('call summary');

    // Next boot: the adapter is healthy again.
    const healthy = stubAdapter();
    const rebooted = gatewayWith({ ledger, adapters: new Map([['telegram', healthy]]) });
    expect(await rebooted.sweepPendingDeliveries()).toEqual({ redelivered: 1, failed: 0 });
    expect(healthy.sent.map((s) => s.message.text)).toEqual(['call summary']);
  });

  it('a throwing adapter is treated exactly like { ok: false }', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const thrower = stubAdapter();
    vi.mocked(thrower.send).mockRejectedValue(new Error('socket hangup'));
    const gw = gatewayWith({ ledger, adapters: new Map([['telegram', thrower]]) });

    await expect(gw.notifyTracked(TARGET, 'call summary')).resolves.toBe(false);
    expect(await ledger.listPending(['bot-a'])).toHaveLength(1);
  });

  // A reply belongs to the sub-conversation it answered, and a redelivery has
  // to return there rather than to the root chat.
  it('carries the threadId onto both the platform call and the obligation', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const failing = stubAdapter({ ok: false });
    const gw = gatewayWith({ ledger, adapters: new Map([['telegram', failing]]) });

    await gw.notifyTracked({ ...TARGET, threadId: 'T-9' }, 'call summary');

    expect(failing.sent[0]?.message.threadId).toBe('T-9');
    expect((await ledger.listPending(['bot-a']))[0]?.threadId).toBe('T-9');
  });

  it('returns false and records the unconfirmed event when no adapter serves the platform', async () => {
    const blocks: Array<{ code: string; cause: string }> = [];
    const gw = gatewayWith({
      ledger: new SQLiteDeliveryLedger(':memory:'),
      adapters: new Map(),
      observability: { recordSafetyBlock: (e) => blocks.push(e) },
    });

    await expect(gw.notifyTracked({ platform: 'discord', chatId: 'C1' }, 'x')).resolves.toBe(false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toBe('gateway.delivery_unconfirmed');
    expect(blocks[0]?.cause).toContain('no adapter registered');
  });

  // An obligation filed under a botKey this process does not own is one the
  // sweep never picks up — a lost message wearing a durable row.
  it('refuses a botKey this process does not serve', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const adapter = stubAdapter();
    const gw = gatewayWith({ ledger, adapters: new Map([['telegram', adapter]]) });

    await expect(gw.notifyTracked({ ...TARGET, botKey: 'bot-elsewhere' }, 'x')).resolves.toBe(
      false,
    );
    expect(adapter.sent).toHaveLength(0);
    expect(await ledger.listPending(['bot-elsewhere'])).toHaveLength(0);
  });

  it('requires an explicit botKey in a multi-bot deployment', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const adapter = stubAdapter();
    const gw = gatewayWith({
      ledger,
      adapters: new Map([['telegram', adapter]]),
      botKeys: ['bot-a', 'bot-b'],
    });

    await expect(gw.notifyTracked(TARGET, 'x')).resolves.toBe(false);
    await expect(gw.notifyTracked({ ...TARGET, botKey: 'bot-b' }, 'x')).resolves.toBe(true);
    expect(adapter.sent).toHaveLength(1);
  });

  it('works with no ledger wired — the send still happens, just without a row', async () => {
    const adapter = stubAdapter();
    const gw = gatewayWith({ adapters: new Map([['telegram', adapter]]) });
    await expect(gw.notifyTracked(TARGET, 'call summary')).resolves.toBe(true);
    expect(adapter.sent).toHaveLength(1);
  });
});
