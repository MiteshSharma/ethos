// Phase-6 acceptance gate at the JSON-RPC layer: async submit + idempotency +
// the P8 delegation ceiling + the per-peer concurrency cap, exercised through
// the real gate stack (token → PoP → delegation → scope).

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { buildDelegationCredentials, signDelegation } from '../delegation';
import { MemoryA2aLimiter } from '../limiter';
import {
  A2A_METHOD_MESSAGE_SEND,
  type A2aAsyncSubmitResult,
  type A2aRequestCredentials,
  createA2aRpcRouter,
  createA2aRpcService,
  type JsonRpcResponse,
} from '../rpc';
import { type A2aTask, InMemoryA2aTaskStore, isTerminalStatus } from '../task-store';
import {
  capturingRunner,
  countingRunner,
  HELLO_SCRIPT,
  hangingRunner,
  makeAgent,
  mintPeerToken,
  newPeerStore,
  type SheetHolder,
  signPop,
  stubIdentity,
  TARGET_ID,
} from './a2a-fixtures';

async function waitForTerminal(store: InMemoryA2aTaskStore, id: string): Promise<A2aTask | null> {
  for (let i = 0; i < 100; i++) {
    const task = await store.get(id);
    if (task && isTerminalStatus(task.status)) return task;
    await new Promise((r) => setTimeout(r, 1));
  }
  return store.get(id);
}

function asyncRpc(skill: string, idempotencyKey: string, message = 'hi') {
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    method: A2A_METHOD_MESSAGE_SEND,
    params: { skill, message, mode: 'async' as const, idempotencyKey },
  };
}

function errorCode(res: JsonRpcResponse): number | undefined {
  return 'error' in res ? res.error.code : undefined;
}

describe('Async message/send — submit + idempotency dedupe', () => {
  it('returns { taskId, status:submitted } immediately and settles completed', async () => {
    const target = makeAgent(TARGET_ID);
    const peer = makeAgent('peer-a');
    const sheet: SheetHolder = { skills: ['search'] };
    const peerStore = newPeerStore();
    const store = new InMemoryA2aTaskStore();
    const counter = { runs: 0 };
    const clock = { t: Date.now() };
    const service = createA2aRpcService({
      getIdentity: stubIdentity(target, sheet),
      peerStore,
      runner: countingRunner(HELLO_SCRIPT, counter),
      taskStore: store,
      now: () => clock.t,
    });
    const minted = await mintPeerToken(target, peer, ['search'], peerStore, { now: clock.t });
    const ts = clock.t;
    const res = await service.handleRpc(TARGET_ID, asyncRpc('search', 'k1'), {
      token: minted.token,
      proofSignature: signPop(peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, ts),
      proofTimestamp: ts,
    });
    if ('error' in res) throw new Error(`unexpected error ${res.error.code}`);
    const ack = res.result as A2aAsyncSubmitResult;
    expect(ack.status).toBe('submitted');
    expect(ack.taskId).toBeTruthy();

    // Let the background run settle.
    const final = await waitForTerminal(store, ack.taskId);
    expect(final?.status).toBe('completed');
    expect(final?.result).toBe('hello world');
    expect(counter.runs).toBe(1);
  });

  it('threads params.skill through to the runner on the async path too (plan T0.2)', async () => {
    const target = makeAgent(TARGET_ID);
    const peer = makeAgent('peer-a');
    const sheet: SheetHolder = { skills: ['search'] };
    const peerStore = newPeerStore();
    const store = new InMemoryA2aTaskStore();
    const clock = { t: Date.now() };
    const captured: Parameters<typeof capturingRunner>[1] = {};
    const service = createA2aRpcService({
      getIdentity: stubIdentity(target, sheet),
      peerStore,
      runner: capturingRunner(HELLO_SCRIPT, captured),
      taskStore: store,
      now: () => clock.t,
    });
    const minted = await mintPeerToken(target, peer, ['search'], peerStore, { now: clock.t });
    const ts = clock.t;
    const res = await service.handleRpc(TARGET_ID, asyncRpc('search', 'k-skill'), {
      token: minted.token,
      proofSignature: signPop(peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, ts),
      proofTimestamp: ts,
    });
    if ('error' in res) throw new Error(`unexpected error ${res.error.code}`);
    const ack = res.result as A2aAsyncSubmitResult;
    await waitForTerminal(store, ack.taskId);
    expect(captured.opts?.skill).toBe('search');
  });

  it('dedupes a retried async send: runner runs EXACTLY once, second returns the prior task', async () => {
    const target = makeAgent(TARGET_ID);
    const peer = makeAgent('peer-a');
    const sheet: SheetHolder = { skills: ['search'] };
    const peerStore = newPeerStore();
    const store = new InMemoryA2aTaskStore();
    const counter = { runs: 0 };
    const clock = { t: Date.now() };
    const service = createA2aRpcService({
      getIdentity: stubIdentity(target, sheet),
      peerStore,
      runner: countingRunner(HELLO_SCRIPT, counter),
      taskStore: store,
      now: () => clock.t,
    });
    const minted = await mintPeerToken(target, peer, ['search'], peerStore, { now: clock.t });

    const send = (ts: number) =>
      service.handleRpc(TARGET_ID, asyncRpc('search', 'dupe-key'), {
        token: minted.token,
        // Fresh PoP each call (proofs are single-use); the idempotency key is stable.
        proofSignature: signPop(peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, ts),
        proofTimestamp: ts,
      });

    const first = await send(clock.t);
    if ('error' in first) throw new Error('first send errored');
    const firstAck = first.result as A2aAsyncSubmitResult;
    // Ensure the background run started + finished before the retry.
    await waitForTerminal(store, firstAck.taskId);

    clock.t += 1000;
    const second = await send(clock.t);
    if ('error' in second) throw new Error('second send errored');
    const secondAck = second.result as A2aAsyncSubmitResult;

    expect(secondAck.taskId).toBe(firstAck.taskId);
    expect(counter.runs).toBe(1); // the runner was NOT invoked a second time
  });
});

describe('P8 — delegation depth ceiling at the RPC layer', () => {
  it('rejects an inbound request whose SIGNED depth ≥ MAX with -32005', async () => {
    const target = makeAgent(TARGET_ID);
    const peer = makeAgent('peer-a');
    const sheet: SheetHolder = { skills: ['search'] };
    const peerStore = newPeerStore();
    const counter = { runs: 0 };
    const clock = { t: Date.now() };
    const service = createA2aRpcService({
      getIdentity: stubIdentity(target, sheet),
      peerStore,
      runner: countingRunner(HELLO_SCRIPT, counter),
      now: () => clock.t,
    });
    const minted = await mintPeerToken(target, peer, ['search'], peerStore, { now: clock.t });
    const ts = clock.t;
    // Signed delegation at depth 3 (== default MAX) by the peer's own key.
    const creds: A2aRequestCredentials = {
      token: minted.token,
      proofSignature: signPop(peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, ts),
      proofTimestamp: ts,
      delegation: buildDelegationCredentials('trace-chain', 3, peer.privateKeyPem),
    };
    const res = await service.handleRpc(
      TARGET_ID,
      {
        jsonrpc: '2.0',
        id: 1,
        method: A2A_METHOD_MESSAGE_SEND,
        params: { skill: 'search', message: 'hi' },
      },
      creds,
    );
    expect(errorCode(res)).toBe(-32005);
    expect(counter.runs).toBe(0);
  });

  it('admits a request one hop below MAX (control)', async () => {
    const target = makeAgent(TARGET_ID);
    const peer = makeAgent('peer-a');
    const sheet: SheetHolder = { skills: ['search'] };
    const peerStore = newPeerStore();
    const counter = { runs: 0 };
    const clock = { t: Date.now() };
    const service = createA2aRpcService({
      getIdentity: stubIdentity(target, sheet),
      peerStore,
      runner: countingRunner(HELLO_SCRIPT, counter),
      now: () => clock.t,
    });
    const minted = await mintPeerToken(target, peer, ['search'], peerStore, { now: clock.t });
    const ts = clock.t;
    const res = await service.handleRpc(
      TARGET_ID,
      {
        jsonrpc: '2.0',
        id: 1,
        method: A2A_METHOD_MESSAGE_SEND,
        params: { skill: 'search', message: 'hi' },
      },
      {
        token: minted.token,
        proofSignature: signPop(peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, ts),
        proofTimestamp: ts,
        delegation: buildDelegationCredentials('trace-chain', 2, peer.privateKeyPem),
      },
    );
    expect('error' in res).toBe(false);
    expect(counter.runs).toBe(1);
  });
});

describe('P8 — spoofed plain depth header is ignored over HTTP', () => {
  it('rejects a request carrying plain x-a2a-depth:0 but a SIGNED depth of MAX', async () => {
    const target = makeAgent(TARGET_ID);
    const peer = makeAgent('peer-a');
    const sheet: SheetHolder = { skills: ['search'] };
    const peerStore = newPeerStore();
    const counter = { runs: 0 };
    const app = new Hono();
    app.route(
      '/a2a',
      createA2aRpcRouter({
        getIdentity: stubIdentity(target, sheet),
        peerStore,
        runner: countingRunner(HELLO_SCRIPT, counter),
      }),
    );
    const minted = await mintPeerToken(target, peer, ['search'], peerStore);
    const ts = Date.now();
    const res = await app.request(`/a2a/${TARGET_ID}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${minted.token}`,
        'x-a2a-pop': signPop(peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, ts),
        'x-a2a-pop-timestamp': String(ts),
        // The attacker resets the PLAIN depth header to 0…
        'x-a2a-depth': '0',
        // …but the SIGNED envelope carries depth 3 (== MAX). Only the signed value counts.
        'x-a2a-trace-id': 'trace-spoof',
        'x-a2a-delegation-depth': '3',
        'x-a2a-delegation-sig': signDelegation('trace-spoof', 3, peer.privateKeyPem),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: A2A_METHOD_MESSAGE_SEND,
        params: { skill: 'search', message: 'hi' },
      }),
    });
    const body = (await res.json()) as JsonRpcResponse;
    expect(errorCode(body)).toBe(-32005);
    expect(counter.runs).toBe(0);
  });
});

describe('§O6 — per-peer concurrency cap returns typed busy (-32004)', () => {
  it('rejects the (cap+1)-th concurrent async task', async () => {
    const target = makeAgent(TARGET_ID);
    const peer = makeAgent('peer-a');
    const sheet: SheetHolder = { skills: ['search'] };
    const peerStore = newPeerStore();
    const store = new InMemoryA2aTaskStore();
    const counter = { runs: 0 };
    const clock = { t: Date.now() };
    const service = createA2aRpcService({
      getIdentity: stubIdentity(target, sheet),
      peerStore,
      // A runner that never completes → the first async task holds its lease open.
      runner: hangingRunner(counter),
      taskStore: store,
      limiter: new MemoryA2aLimiter({ maxConcurrentPerPeer: 1, ratePerWindow: 1000 }),
      now: () => clock.t,
    });
    const minted = await mintPeerToken(target, peer, ['search'], peerStore, { now: clock.t });

    const send = (ts: number, key: string) =>
      service.handleRpc(TARGET_ID, asyncRpc('search', key), {
        token: minted.token,
        proofSignature: signPop(peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, ts),
        proofTimestamp: ts,
      });

    const first = await send(clock.t, 'k1');
    expect('error' in first).toBe(false); // submitted, lease held by the hanging run

    clock.t += 1000;
    const second = await send(clock.t, 'k2');
    expect(errorCode(second)).toBe(-32004); // over the concurrency cap → typed busy
  });
});
