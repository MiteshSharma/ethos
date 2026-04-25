import type { AgentLoop } from '@ethosagent/core';
import { describe, expect, it, vi } from 'vitest';
import { AgentBridge } from '../agent-bridge';

async function* makeEventStream(
  events: { type: string; [k: string]: unknown }[],
): AsyncGenerator<unknown> {
  for (const e of events) yield e;
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
    vi.advanceTimersByTime(20);

    // done event flushes synchronously inside the loop iteration
    await sendPromise;

    // Both deltas should be flushed as one batch before done
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

  it('does not start a second send while one is running', async () => {
    const loop = {
      run: vi.fn(() => makeEventStream([{ type: 'done', text: '', turnCount: 1 }])),
    } as unknown as AgentLoop;

    const bridge = new AgentBridge(loop);
    await Promise.all([bridge.send('a', {}), bridge.send('b', {})]);

    expect(loop.run).toHaveBeenCalledTimes(1);
  });
});
