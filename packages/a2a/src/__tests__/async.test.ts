// Async task lifecycle (plan §10 / §17 Phase 6) — the responder manager.

import type { AgentEvent } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { A2aAsyncManager } from '../async';
import type { A2aTaskRunner } from '../rpc';
import { InMemoryA2aTaskStore } from '../task-store';

function scriptRunner(script: AgentEvent[], counter: { runs: number }): A2aTaskRunner {
  return {
    async *run() {
      counter.runs += 1;
      for (const e of script) yield e;
    },
  };
}

const HELLO: AgentEvent[] = [
  { type: 'text_delta', text: 'hello world' },
  { type: 'done', text: 'hello world', turnCount: 1 },
];

describe('A2aAsyncManager — completion', () => {
  it('runs in the background and settles completed with the assistant text', async () => {
    const store = new InMemoryA2aTaskStore();
    const counter = { runs: 0 };
    const mgr = new A2aAsyncManager({ taskStore: store, runner: scriptRunner(HELLO, counter) });

    const task = await mgr.submit({
      personalityId: 'researcher',
      peerFingerprint: 'fp-a',
      message: 'hi',
      sessionKey: 's',
      traceId: 't',
      depth: 0,
      idempotencyKey: 'k1',
    });
    expect(task.status).toBe('submitted');

    const settled = await mgr.settled(task.id);
    expect(settled?.status).toBe('completed');
    expect(settled?.result).toBe('hello world');
    expect(counter.runs).toBe(1);
  });

  it('maps a runner error to failed (not a catch-all)', async () => {
    const store = new InMemoryA2aTaskStore();
    const counter = { runs: 0 };
    const mgr = new A2aAsyncManager({
      taskStore: store,
      runner: scriptRunner([{ type: 'error', error: 'boom', code: 'INTERNAL' }], counter),
    });
    const task = await mgr.submit({
      personalityId: 'researcher',
      peerFingerprint: 'fp-a',
      message: 'hi',
      sessionKey: 's',
      traceId: 't',
      depth: 0,
      idempotencyKey: 'k',
    });
    const settled = await mgr.settled(task.id);
    expect(settled?.status).toBe('failed');
    expect(settled?.error).toBe('boom');
  });
});

describe('A2aAsyncManager — idempotency dedupe (no double run)', () => {
  it('a retried send with the same key returns the prior task and runs EXACTLY once', async () => {
    const store = new InMemoryA2aTaskStore();
    const counter = { runs: 0 };
    const mgr = new A2aAsyncManager({ taskStore: store, runner: scriptRunner(HELLO, counter) });
    const args = {
      personalityId: 'researcher',
      peerFingerprint: 'fp-a',
      message: 'hi',
      sessionKey: 's',
      traceId: 't',
      depth: 0,
      idempotencyKey: 'same-key',
    } as const;

    const first = await mgr.submit(args);
    await mgr.settled(first.id);
    const second = await mgr.submit(args);

    expect(second.id).toBe(first.id);
    expect(counter.runs).toBe(1);
  });

  it('scopes the idempotency key by peer fingerprint', async () => {
    const store = new InMemoryA2aTaskStore();
    const counter = { runs: 0 };
    const mgr = new A2aAsyncManager({ taskStore: store, runner: scriptRunner(HELLO, counter) });
    const base = {
      personalityId: 'researcher',
      message: 'hi',
      sessionKey: 's',
      traceId: 't',
      depth: 0,
      idempotencyKey: 'k',
    };
    const a = await mgr.submit({ ...base, peerFingerprint: 'fp-a' });
    await mgr.settled(a.id);
    const b = await mgr.submit({ ...base, peerFingerprint: 'fp-b' });
    await mgr.settled(b.id);
    expect(b.id).not.toBe(a.id);
    expect(counter.runs).toBe(2);
  });
});
