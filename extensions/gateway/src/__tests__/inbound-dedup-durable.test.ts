import type { AgentLoop } from '@ethosagent/core';
import type { InboundDedupStore } from '@ethosagent/inbound-dedup';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';

// ---------------------------------------------------------------------------
// Durable inbound dedup (plan/phases/telegram-slack-webhook-mode.md §5, §9).
//
// The in-memory `Set` is emptied by a process restart. Under webhook mode with
// scale-to-zero those restarts are routine, so a platform redelivery landing on
// a fresh process is fully reprocessed — and billed — a second time. These
// tests drive that scenario through `handleMessage` and assert on the
// downstream effect (whether the loop ran), not on the dedup helper's return
// value.
// ---------------------------------------------------------------------------

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
    run: vi.fn(async function* () {
      yield { type: 'done' as const, text: 'reply', turnCount: 1 };
    }),
    hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
  };
}

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'telegram',
    chatId: '100',
    userId: '200',
    text: 'hello',
    isDm: true,
    isGroupMention: false,
    messageId: '1',
    botKey: 'test-bot',
    raw: {},
    ...overrides,
  };
}

/**
 * Map-backed `InboundDedupStore`. Stands in for `SQLiteInboundDedupStore`,
 * whose durability and TTL behaviour are proven in that package's own tests —
 * what matters here is that the Gateway consults a store that OUTLIVES the
 * process, which a shared object models exactly.
 */
function fakeStore(): InboundDedupStore & { seen: ReturnType<typeof vi.fn> } {
  const keys = new Set<string>();
  return {
    seen: vi.fn((platform: string, botKey: string, chatId: string, messageId: string) => {
      const key = `${platform}:${botKey}:${chatId}:${messageId}`;
      if (keys.has(key)) return true;
      keys.add(key);
      return false;
    }),
    close: vi.fn(),
  };
}

function makeGateway(loop: ReturnType<typeof stubLoop>, extra: Record<string, unknown> = {}) {
  return new Gateway({
    bots: [
      {
        botKey: 'test-bot',
        loop: loop as unknown as AgentLoop,
        binding: { type: 'personality', name: 'default' },
      },
    ],
    clarifySweepIntervalMs: 0,
    ...extra,
  });
}

describe('Gateway — durable inbound dedup backstop', () => {
  it('drops a redelivery that arrives at a restarted process sharing the durable store', async () => {
    const store = fakeStore();
    const adapter = stubAdapter();

    const firstLoop = stubLoop();
    await makeGateway(firstLoop, { inboundDedup: store }).handleMessage(makeMessage(), adapter);
    expect(firstLoop.run).toHaveBeenCalledTimes(1);

    // Process restart: brand-new Gateway, empty in-memory Set, same store.
    const secondLoop = stubLoop();
    await makeGateway(secondLoop, { inboundDedup: store }).handleMessage(makeMessage(), adapter);
    expect(secondLoop.run).not.toHaveBeenCalled();
  });

  it('reprocesses the same redelivery when no durable store is configured (the gap)', async () => {
    const adapter = stubAdapter();

    const firstLoop = stubLoop();
    await makeGateway(firstLoop).handleMessage(makeMessage(), adapter);
    expect(firstLoop.run).toHaveBeenCalledTimes(1);

    const secondLoop = stubLoop();
    await makeGateway(secondLoop).handleMessage(makeMessage(), adapter);
    expect(secondLoop.run).toHaveBeenCalledTimes(1);
  });

  it('does not touch the durable store when the in-memory Set already has the key', async () => {
    const store = fakeStore();
    const adapter = stubAdapter();
    const loop = stubLoop();
    const gw = makeGateway(loop, { inboundDedup: store });

    await gw.handleMessage(makeMessage(), adapter);
    await gw.handleMessage(makeMessage(), adapter);

    expect(loop.run).toHaveBeenCalledTimes(1);
    // The fast path is the whole reason both layers are kept: a continuously
    // running process pays no SQLite read per inbound message.
    expect(store.seen).toHaveBeenCalledTimes(1);
  });

  it('dedupWindow: 0 disables both layers', async () => {
    const store = fakeStore();
    const adapter = stubAdapter();
    const loop = stubLoop();
    const gw = makeGateway(loop, { inboundDedup: store, dedupWindow: 0 });

    await gw.handleMessage(makeMessage(), adapter);
    await gw.handleMessage(makeMessage(), adapter);

    expect(loop.run).toHaveBeenCalledTimes(2);
    expect(store.seen).not.toHaveBeenCalled();
  });

  it('still bypasses dedup for an isEdit message with a durable store configured', async () => {
    const store = fakeStore();
    const adapter = stubAdapter();
    const loop = stubLoop();
    const gw = makeGateway(loop, { inboundDedup: store });

    await gw.handleMessage(makeMessage({ text: 'original' }), adapter);
    await gw.handleMessage(makeMessage({ text: 'corrected', isEdit: true }), adapter);

    expect(loop.run).toHaveBeenCalledTimes(2);
  });
});

// Codex review finding: the in-memory key was recorded BEFORE the durable
// write. A throw from SQLite then left the process holding a sighting that was
// never persisted, and every platform retry short-circuited on it — silently
// discarding the message the retry existed to save.
describe('a throwing durable store must not poison the in-memory Set', () => {
  it('leaves the key unrecorded, so the retry is reprocessed rather than dropped', async () => {
    const throwing: InboundDedupStore = {
      seen: () => {
        throw new Error('database is locked');
      },
      close: () => {},
    };
    const adapter = stubAdapter();
    const loop = stubLoop();
    const gateway = makeGateway(loop, { inboundDedup: throwing });

    await expect(gateway.handleMessage(makeMessage(), adapter)).rejects.toThrow(
      'database is locked',
    );
    expect(loop.run).not.toHaveBeenCalled();

    // The platform retries into the SAME process. Recording the key before the
    // durable call meant this hit the poisoned Set and vanished; now the
    // durable layer is consulted again and the message gets its chance.
    await expect(gateway.handleMessage(makeMessage(), adapter)).rejects.toThrow(
      'database is locked',
    );

    // And once the store recovers, the retry is actually processed.
    const healthy = makeGateway(loop, { inboundDedup: fakeStore() });
    await healthy.handleMessage(makeMessage(), adapter);
    expect(loop.run).toHaveBeenCalledTimes(1);
  });
});
