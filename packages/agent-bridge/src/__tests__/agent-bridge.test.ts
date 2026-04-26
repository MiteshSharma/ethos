import type { AgentLoop } from '@ethosagent/core';
import { describe, expect, it, vi } from 'vitest';
import { AgentBridge } from '../agent-bridge';

async function* makeEventStream(
  events: { type: string; [k: string]: unknown }[],
): AsyncGenerator<unknown> {
  for (const e of events) {
    // Yield to microtasks between events so concurrent send() calls during
    // a turn actually see this.controller != null in the bridge.
    await Promise.resolve();
    yield e;
  }
}

describe('AgentBridge', () => {
  it('throttles text_delta to 16ms batches', async () => {
    vi.useFakeTimers();

    const loop = {
      run: vi.fn(() =>
        makeEventStream([
          { type: 'text_delta', text: 'Hello' },
          { type: 'text_delta', text: ' World' },
          { type: 'done', text: 'Hello World', turnCount: 1 },
        ]),
      ),
    } as unknown as AgentLoop;

    const bridge = new AgentBridge(loop);
    const textDeltas: string[] = [];
    bridge.on('text_delta', (t) => textDeltas.push(t));

    const sendPromise = bridge.send('hi', {});

    // Before timer fires, no text_delta emitted (buffered)
    expect(textDeltas).toHaveLength(0);

    // Advance timer past 16ms — flush fires
    await vi.advanceTimersByTimeAsync(20);

    await sendPromise;

    // Both deltas should be flushed before done
    expect(textDeltas.join('')).toBe('Hello World');

    vi.useRealTimers();
  });

  it('emits done with full text after flush', async () => {
    const loop = {
      run: vi.fn(() =>
        makeEventStream([
          { type: 'text_delta', text: 'Hi' },
          { type: 'done', text: 'Hi', turnCount: 1 },
        ]),
      ),
    } as unknown as AgentLoop;

    const bridge = new AgentBridge(loop);
    const doneTexts: string[] = [];
    bridge.on('done', (text) => doneTexts.push(text));

    await bridge.send('hello', {});

    expect(doneTexts).toEqual(['Hi']);
  });

  it('emits idle after turn regardless of error', async () => {
    const loop = {
      run: vi.fn(() => makeEventStream([{ type: 'error', error: 'boom', code: 'ERR' }])),
    } as unknown as AgentLoop;

    const bridge = new AgentBridge(loop);
    let idleFired = false;
    bridge.on('idle', () => {
      idleFired = true;
    });
    bridge.on('error', () => {}); // prevent unhandled-error throw

    await bridge.send('x', {});
    expect(idleFired).toBe(true);
  });

  it('abortTurn cancels the running turn', async () => {
    let aborted = false;
    const loop = {
      run: vi.fn((_text: string, opts: { abortSignal?: AbortSignal }) => {
        opts.abortSignal?.addEventListener('abort', () => {
          aborted = true;
        });
        return makeEventStream([]);
      }),
    } as unknown as AgentLoop;

    const bridge = new AgentBridge(loop);
    const sendPromise = bridge.send('test', {});
    bridge.abortTurn();
    await sendPromise;

    expect(aborted).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Concurrent-send queue (eng-review finding 1.3)
  // ---------------------------------------------------------------------------

  it('queues a second send while a turn is running and processes both in order', async () => {
    const calls: string[] = [];
    const loop = {
      run: vi.fn((text: string) => {
        calls.push(text);
        return makeEventStream([{ type: 'done', text, turnCount: 1 }]);
      }),
    } as unknown as AgentLoop;

    const bridge = new AgentBridge(loop);
    const queuedFor: string[] = [];
    bridge.on('queued', (input) => queuedFor.push(input));

    // Wait until two `idle` events fire (one per turn).
    let idleCount = 0;
    const bothIdle = new Promise<void>((resolve) => {
      bridge.on('idle', () => {
        idleCount += 1;
        if (idleCount === 2) resolve();
      });
    });

    void bridge.send('first', {});
    void bridge.send('second', {});

    await bothIdle;

    expect(loop.run).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(['first', 'second']);
    expect(queuedFor).toEqual(['second']);
  });

  it('rejects with BUSY when the queue is at capacity', async () => {
    const loop = {
      run: vi.fn(() => makeEventStream([{ type: 'done', text: '', turnCount: 1 }])),
    } as unknown as AgentLoop;

    const bridge = new AgentBridge(loop, { queueCap: 1 });
    const errors: Array<{ msg: string; code: string }> = [];
    bridge.on('error', (msg, code) => errors.push({ msg, code }));
    bridge.on('queued', () => {});

    void bridge.send('first', {}); // running
    void bridge.send('second', {}); // queued (cap=1)
    void bridge.send('third', {}); // rejected (cap exceeded)

    // wait one microtask round so the synchronous queue checks above resolve
    await new Promise((r) => setTimeout(r, 0));

    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('BUSY');
  });

  it('clearQueue drops pending sends without affecting the in-flight turn', async () => {
    const calls: string[] = [];
    const loop = {
      run: vi.fn((text: string) => {
        calls.push(text);
        return makeEventStream([{ type: 'done', text, turnCount: 1 }]);
      }),
    } as unknown as AgentLoop;

    const bridge = new AgentBridge(loop);

    let idleSeen = 0;
    const firstIdle = new Promise<void>((resolve) => {
      bridge.on('idle', () => {
        idleSeen += 1;
        if (idleSeen === 1) resolve();
      });
    });

    void bridge.send('first', {});
    void bridge.send('queued-but-dropped', {});

    expect(bridge.queueDepth).toBe(1);
    const dropped = bridge.clearQueue();
    expect(dropped).toBe(1);
    expect(bridge.queueDepth).toBe(0);

    await firstIdle;

    // Only the first turn ran; queued one was dropped before it could fire.
    expect(loop.run).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['first']);
  });
});
