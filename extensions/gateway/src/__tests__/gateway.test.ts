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
