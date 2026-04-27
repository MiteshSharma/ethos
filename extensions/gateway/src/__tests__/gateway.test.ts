import type { AgentEvent } from '@ethosagent/core';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway, SessionLane } from '../index';

// ---------------------------------------------------------------------------
// SessionLane
// ---------------------------------------------------------------------------

describe('SessionLane', () => {
  it('runs tasks sequentially', async () => {
    const lane = new SessionLane();
    const order: number[] = [];

    await Promise.all([
      lane.enqueue(async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(1);
      }),
      lane.enqueue(async () => {
        order.push(2);
      }),
      lane.enqueue(async () => {
        order.push(3);
      }),
    ]);

    expect(order).toEqual([1, 2, 3]);
  });

  it('abort cancels the running task and drops queued tasks', async () => {
    const lane = new SessionLane();
    const completed: number[] = [];

    const first = lane.enqueue(async (signal) => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (!signal.aborted) completed.push(1);
    });

    const second = lane.enqueue(async () => {
      completed.push(2);
    });
    const third = lane.enqueue(async () => {
      completed.push(3);
    });

    lane.abort();

    await Promise.allSettled([first, second, third]);

    // None of the tasks should complete after abort
    expect(completed).toHaveLength(0);
  });

  it('length reflects queue depth', async () => {
    const lane = new SessionLane();
    expect(lane.length).toBe(0);

    let unblock!: () => void;
    const blocker = lane.enqueue(async () => {
      await new Promise<void>((r) => {
        unblock = r;
      });
    });

    // Enqueue two more while blocker is running
    const p2 = lane.enqueue(async () => {});
    const p3 = lane.enqueue(async () => {});

    // length = 1 running + 2 queued = 3
    expect(lane.length).toBe(3);
    unblock();
    await Promise.all([blocker, p2, p3]);
    expect(lane.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

function makeMessage(text: string, chatId = '42'): InboundMessage {
  return {
    platform: 'telegram',
    chatId,
    text,
    isDm: true,
    isGroupMention: false,
    raw: {},
  };
}

function makeAdapter() {
  const sent: string[] = [];
  const adapter: PlatformAdapter = {
    id: 'test',
    displayName: 'Test',
    canSendTyping: true,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
    send: async (_chatId, msg) => {
      sent.push(msg.text);
      return { ok: true };
    },
    sendTyping: async () => {},
    health: async () => ({ ok: true }),
  };
  return { adapter, sent };
}

function makeLoop(response: string) {
  async function* mockRun(): AsyncGenerator<AgentEvent> {
    yield { type: 'text_delta', text: response };
    yield { type: 'done', text: response, turnCount: 1 };
  }

  return {
    run: (_text: string, _opts: unknown) => mockRun(),
  } as unknown as import('@ethosagent/core').AgentLoop;
}

describe('Gateway', () => {
  it('handles a normal message and sends agent response', async () => {
    const loop = makeLoop('Hello from agent!');
    const gateway = new Gateway({ loop });
    const { adapter, sent } = makeAdapter();

    await gateway.handleMessage(makeMessage('hi'), adapter);

    expect(sent).toContain('Hello from agent!');
  });

  it('/new starts a fresh session and sends confirmation', async () => {
    const loop = makeLoop('response');
    const gateway = new Gateway({ loop });
    const { adapter, sent } = makeAdapter();

    await gateway.handleMessage(makeMessage('/new'), adapter);

    expect(sent.some((s) => s.includes('New session'))).toBe(true);
  });

  it('/stop sends confirmation', async () => {
    const loop = makeLoop('response');
    const gateway = new Gateway({ loop });
    const { adapter, sent } = makeAdapter();

    await gateway.handleMessage(makeMessage('/stop'), adapter);

    expect(sent.some((s) => s.includes('Stopped'))).toBe(true);
  });

  it('/help sends command list', async () => {
    const loop = makeLoop('response');
    const gateway = new Gateway({ loop });
    const { adapter, sent } = makeAdapter();

    await gateway.handleMessage(makeMessage('/help'), adapter);

    expect(sent.some((s) => s.includes('/new'))).toBe(true);
  });

  it('/usage shows zero stats on fresh session', async () => {
    const loop = makeLoop('response');
    const gateway = new Gateway({ loop });
    const { adapter, sent } = makeAdapter();

    await gateway.handleMessage(makeMessage('/usage'), adapter);

    expect(sent.some((s) => s.includes('Tokens'))).toBe(true);
  });

  // Inbound dedup — see plan/IMPROVEMENT.md P2-2 / OpenClaw #71761.
  // Polling reconnects, webhook retries, and double-delivery should never
  // result in the AgentLoop being invoked twice for the same logical message.

  describe('inbound dedup', () => {
    it('drops a duplicate message with the same (platform, chatId, messageId)', async () => {
      const runs: string[] = [];
      async function* mockRun(text: string): AsyncGenerator<AgentEvent> {
        runs.push(text);
        yield { type: 'done', text: 'ok', turnCount: 1 };
      }
      const loop = {
        run: (text: string) => mockRun(text),
      } as unknown as import('@ethosagent/core').AgentLoop;

      const gateway = new Gateway({ loop });
      const { adapter } = makeAdapter();
      const msg: InboundMessage = {
        platform: 'telegram',
        chatId: '42',
        text: 'hello',
        isDm: true,
        isGroupMention: false,
        messageId: 'tg-1',
        raw: {},
      };

      await gateway.handleMessage(msg, adapter);
      await gateway.handleMessage(msg, adapter);

      expect(runs).toHaveLength(1);
    });

    it('treats different messageIds as distinct', async () => {
      const runs: string[] = [];
      async function* mockRun(text: string): AsyncGenerator<AgentEvent> {
        runs.push(text);
        yield { type: 'done', text: 'ok', turnCount: 1 };
      }
      const loop = {
        run: (text: string) => mockRun(text),
      } as unknown as import('@ethosagent/core').AgentLoop;

      const gateway = new Gateway({ loop });
      const { adapter } = makeAdapter();
      const base: Omit<InboundMessage, 'messageId' | 'text'> = {
        platform: 'telegram',
        chatId: '42',
        isDm: true,
        isGroupMention: false,
        raw: {},
      };

      await gateway.handleMessage({ ...base, text: 'first', messageId: 'tg-1' }, adapter);
      await gateway.handleMessage({ ...base, text: 'second', messageId: 'tg-2' }, adapter);

      expect(runs).toEqual(['first', 'second']);
    });

    it('does not dedup messages without a messageId (key absent → no dedup possible)', async () => {
      const runs: string[] = [];
      async function* mockRun(text: string): AsyncGenerator<AgentEvent> {
        runs.push(text);
        yield { type: 'done', text: 'ok', turnCount: 1 };
      }
      const loop = {
        run: (text: string) => mockRun(text),
      } as unknown as import('@ethosagent/core').AgentLoop;

      const gateway = new Gateway({ loop });
      const { adapter } = makeAdapter();
      const msg: InboundMessage = {
        platform: 'telegram',
        chatId: '42',
        text: 'hello',
        isDm: true,
        isGroupMention: false,
        raw: {}, // no messageId
      };

      await gateway.handleMessage(msg, adapter);
      await gateway.handleMessage(msg, adapter);

      expect(runs).toHaveLength(2);
    });

    it('respects dedupWindow=0 (dedup disabled)', async () => {
      const runs: string[] = [];
      async function* mockRun(text: string): AsyncGenerator<AgentEvent> {
        runs.push(text);
        yield { type: 'done', text: 'ok', turnCount: 1 };
      }
      const loop = {
        run: (text: string) => mockRun(text),
      } as unknown as import('@ethosagent/core').AgentLoop;

      const gateway = new Gateway({ loop, dedupWindow: 0 });
      const { adapter } = makeAdapter();
      const msg: InboundMessage = {
        platform: 'telegram',
        chatId: '42',
        text: 'hello',
        isDm: true,
        isGroupMention: false,
        messageId: 'tg-1',
        raw: {},
      };

      await gateway.handleMessage(msg, adapter);
      await gateway.handleMessage(msg, adapter);

      expect(runs).toHaveLength(2);
    });

    it('evicts oldest entries beyond the dedup window', async () => {
      const runs: string[] = [];
      async function* mockRun(text: string): AsyncGenerator<AgentEvent> {
        runs.push(text);
        yield { type: 'done', text: 'ok', turnCount: 1 };
      }
      const loop = {
        run: (text: string) => mockRun(text),
      } as unknown as import('@ethosagent/core').AgentLoop;

      const gateway = new Gateway({ loop, dedupWindow: 2 });
      const { adapter } = makeAdapter();
      const base: Omit<InboundMessage, 'messageId' | 'text'> = {
        platform: 'telegram',
        chatId: '42',
        isDm: true,
        isGroupMention: false,
        raw: {},
      };

      await gateway.handleMessage({ ...base, text: 'a', messageId: 'tg-1' }, adapter);
      await gateway.handleMessage({ ...base, text: 'b', messageId: 'tg-2' }, adapter);
      // Window is full; tg-1 should now be evicted.
      await gateway.handleMessage({ ...base, text: 'c', messageId: 'tg-3' }, adapter);
      // tg-1 was evicted, so re-sending it should NOT be deduped.
      await gateway.handleMessage({ ...base, text: 'a-again', messageId: 'tg-1' }, adapter);
      // tg-3 is still in the window, so a duplicate IS deduped.
      await gateway.handleMessage({ ...base, text: 'c-again', messageId: 'tg-3' }, adapter);

      expect(runs).toEqual(['a', 'b', 'c', 'a-again']);
    });
  });

  // Mid-turn-safe shutdown — see plan/IMPROVEMENT.md P1-1 / OpenClaw #71178.
  // SIGINT/SIGTERM during an in-flight turn must surface to the user, not
  // silently drop the response.

  describe('graceful shutdown with notify', () => {
    it('sends notify text to every chat with an in-flight turn', async () => {
      let unblock!: () => void;
      const blocker = new Promise<void>((r) => {
        unblock = r;
      });

      async function* slowRun(): AsyncGenerator<AgentEvent> {
        await blocker; // hang until released or aborted
        yield { type: 'done', text: 'never reaches user', turnCount: 1 };
      }

      const loop = {
        run: () => slowRun(),
      } as unknown as import('@ethosagent/core').AgentLoop;

      const gateway = new Gateway({ loop });
      const { adapter, sent } = makeAdapter();

      // Kick off two parallel chats whose turns will hang
      const p1 = gateway.handleMessage(
        { ...makeMessage('hi', 'chatA'), messageId: 'a-1' },
        adapter,
      );
      const p2 = gateway.handleMessage(
        { ...makeMessage('hi', 'chatB'), messageId: 'b-1' },
        adapter,
      );

      // Give the lanes a tick to actually start the LLM run (so activeTurns is populated)
      await new Promise((r) => setTimeout(r, 10));

      // Now shut down with notify
      await gateway.shutdown({ notify: '⚠ interrupted' });

      // Release any remaining work so promises resolve
      unblock();
      await Promise.allSettled([p1, p2]);

      // Both chats received the interruption notice
      expect(sent.filter((s) => s.includes('interrupted')).length).toBeGreaterThanOrEqual(2);
    });

    it('does not notify chats with no in-flight turn', async () => {
      const loop = makeLoop('done');
      const gateway = new Gateway({ loop });
      const { adapter, sent } = makeAdapter();

      // Send a message that completes synchronously, then shutdown
      await gateway.handleMessage({ ...makeMessage('hi', 'chatA'), messageId: 'a-1' }, adapter);
      const sentCountBefore = sent.length;
      await gateway.shutdown({ notify: '⚠ interrupted' });

      // No new sends — nothing was in flight when shutdown ran
      expect(sent.length).toBe(sentCountBefore);
    });

    it('shutdown without notify is silent (back-compat)', async () => {
      const loop = makeLoop('done');
      const gateway = new Gateway({ loop });
      const { adapter, sent } = makeAdapter();

      await gateway.handleMessage(makeMessage('hi'), adapter);
      const sentCountBefore = sent.length;
      await gateway.shutdown();

      expect(sent.length).toBe(sentCountBefore);
    });
  });

  it('different chatIds use independent lanes', async () => {
    const order: string[] = [];
    async function* slowRun(): AsyncGenerator<AgentEvent> {
      await new Promise((r) => setTimeout(r, 20));
      order.push('chat1');
      yield { type: 'done', text: 'done', turnCount: 1 };
    }
    async function* fastRun(): AsyncGenerator<AgentEvent> {
      order.push('chat2');
      yield { type: 'done', text: 'done', turnCount: 1 };
    }
    let call = 0;
    const loop = {
      run: () => (call++ === 0 ? slowRun() : fastRun()),
    } as unknown as import('@ethosagent/core').AgentLoop;

    const gateway = new Gateway({ loop });
    const { adapter } = makeAdapter();

    await Promise.all([
      gateway.handleMessage(makeMessage('slow', 'chat1'), adapter),
      gateway.handleMessage(makeMessage('fast', 'chat2'), adapter),
    ]);

    // chat2 should finish before chat1 since they run in parallel
    expect(order[0]).toBe('chat2');
    expect(order[1]).toBe('chat1');
  });
});
