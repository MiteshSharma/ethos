// Plan T1.4 acceptance gate — the pre-auth rate limiter, the request-body cap,
// and the SSE connection cap. `authenticate()` used to run BEFORE any
// rate-limiting (a full Ed25519/JWT verification per unauthenticated request);
// these tests prove the new pre-auth gate rejects a flood WITHOUT running that
// crypto, and that the two new resource caps are enforced.

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { MemoryA2aPreAuthLimiter } from '../limiter';
import {
  A2A_METHOD_MESSAGE_SEND,
  type A2aRequestCredentials,
  createA2aRpcRouter,
  createA2aRpcService,
} from '../rpc';
import { InMemoryA2aTaskStore } from '../task-store';
import * as tokensModule from '../tokens';
import {
  countingRunner,
  HELLO_SCRIPT,
  makeAgent,
  mintPeerToken,
  newPeerStore,
  signPop,
  stubIdentity,
  TARGET_ID,
} from './a2a-fixtures';

describe('pre-auth rate limiting (plan T1.4) — rejects BEFORE crypto runs', () => {
  it('a request over the pre-auth threshold is rejected without a validateToken call', async () => {
    const target = makeAgent(TARGET_ID);
    const peer = makeAgent('peer');
    const peerStore = newPeerStore();
    const sheet = { skills: ['search'] };
    const counter = { runs: 0 };
    const minted = await mintPeerToken(target, peer, ['search'], peerStore, { now: 0 });

    const validateTokenSpy = vi.spyOn(tokensModule, 'validateToken');

    const preAuthLimiter = new MemoryA2aPreAuthLimiter({
      maxPerWindow: 2,
      windowMs: 10_000,
      now: () => 0,
    });
    const service = createA2aRpcService({
      getIdentity: stubIdentity(target, sheet),
      peerStore,
      runner: countingRunner(HELLO_SCRIPT, counter),
      now: () => 0,
      preAuthLimiter,
    });

    const makeReq = (id: number) => ({
      jsonrpc: '2.0' as const,
      id,
      method: A2A_METHOD_MESSAGE_SEND,
      params: { skill: 'search', message: 'hi' },
    });
    const makeCreds = (ts: number): A2aRequestCredentials => ({
      token: minted.token,
      proofSignature: signPop(peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, ts),
      proofTimestamp: ts,
      remoteKey: 'attacker-ip',
    });

    // Two requests consume the pre-auth budget; both are LEGITIMATE (valid
    // token + PoP) so they reach `authenticate()` and call `validateToken`.
    const r1 = await service.handleRpc(target.id, makeReq(1), makeCreds(0));
    const r2 = await service.handleRpc(target.id, makeReq(2), makeCreds(1));
    expect('result' in r1).toBe(true);
    expect('result' in r2).toBe(true);
    const callsAfterTwo = validateTokenSpy.mock.calls.length;
    expect(callsAfterTwo).toBe(2);

    // Third request, same remote key, is over budget — rejected WITHOUT ever
    // calling validateToken (the crypto verification path).
    const r3 = await service.handleRpc(target.id, makeReq(3), makeCreds(2));
    expect('error' in r3 && r3.error.code).toBe(-32004);
    expect(validateTokenSpy.mock.calls.length).toBe(callsAfterTwo);
    expect(counter.runs).toBe(2); // only the two admitted requests ran a turn

    validateTokenSpy.mockRestore();
  });

  it('an authenticated peer under its existing per-peer quota is unaffected by the pre-auth limiter', async () => {
    const target = makeAgent(TARGET_ID);
    const peer = makeAgent('peer');
    const peerStore = newPeerStore();
    const sheet = { skills: ['search'] };
    const counter = { runs: 0 };
    const minted = await mintPeerToken(target, peer, ['search'], peerStore, { now: 0 });

    // A generous pre-auth budget — plenty of headroom for a normal peer.
    const preAuthLimiter = new MemoryA2aPreAuthLimiter({ maxPerWindow: 1000, now: () => 0 });
    const service = createA2aRpcService({
      getIdentity: stubIdentity(target, sheet),
      peerStore,
      runner: countingRunner(HELLO_SCRIPT, counter),
      now: () => 0,
      preAuthLimiter,
    });

    for (let i = 0; i < 5; i++) {
      const req = {
        jsonrpc: '2.0' as const,
        id: i,
        method: A2A_METHOD_MESSAGE_SEND,
        params: { skill: 'search', message: 'hi' },
      };
      const creds: A2aRequestCredentials = {
        token: minted.token,
        proofSignature: signPop(peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, i),
        proofTimestamp: i,
        remoteKey: 'peer-ip',
      };
      const res = await service.handleRpc(target.id, req, creds);
      expect('result' in res).toBe(true);
    }
    expect(counter.runs).toBe(5);
  });
});

describe('MemoryA2aPreAuthLimiter — sliding window (unit)', () => {
  it('rejects once the window is saturated and admits again after it slides', () => {
    let t = 0;
    const limiter = new MemoryA2aPreAuthLimiter({ maxPerWindow: 2, windowMs: 1000, now: () => t });
    expect(limiter.check('k')).toBe(true);
    expect(limiter.check('k')).toBe(true);
    expect(limiter.check('k')).toBe(false);
    t += 1001;
    expect(limiter.check('k')).toBe(true);
  });

  it('tracks each key independently', () => {
    const limiter = new MemoryA2aPreAuthLimiter({ maxPerWindow: 1, now: () => 0 });
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('a')).toBe(false);
    expect(limiter.check('b')).toBe(true);
  });
});

describe('request body cap (plan T1.4)', () => {
  it('rejects a body over the configured cap', async () => {
    const target = makeAgent(TARGET_ID);
    const sheet = { skills: ['search'] };
    const counter = { runs: 0 };
    const app = new Hono();
    app.route(
      '/a2a',
      createA2aRpcRouter({
        getIdentity: stubIdentity(target, sheet),
        peerStore: newPeerStore(),
        runner: countingRunner(HELLO_SCRIPT, counter),
        maxBodyBytes: 100,
      }),
    );

    const oversized = 'x'.repeat(500);
    const res = await app.request(`/a2a/${target.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: A2A_METHOD_MESSAGE_SEND,
        params: { skill: 'search', message: oversized },
      }),
    });
    expect(res.status).toBe(413);
    const json = (await res.json()) as { error: { code: number } };
    expect(json.error.code).toBe(-32006);
    expect(counter.runs).toBe(0);
  });

  it('accepts a body within the cap', async () => {
    const target = makeAgent(TARGET_ID);
    const peer = makeAgent('peer');
    const peerStore = newPeerStore();
    const sheet = { skills: ['search'] };
    const counter = { runs: 0 };
    const minted = await mintPeerToken(target, peer, ['search'], peerStore, { now: 0 });
    const app = new Hono();
    app.route(
      '/a2a',
      createA2aRpcRouter({
        getIdentity: stubIdentity(target, sheet),
        peerStore,
        runner: countingRunner(HELLO_SCRIPT, counter),
        maxBodyBytes: 100_000,
        now: () => 0,
      }),
    );

    const res = await app.request(`/a2a/${target.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${minted.token}`,
        'x-a2a-pop': signPop(peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, 0),
        'x-a2a-pop-timestamp': '0',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: A2A_METHOD_MESSAGE_SEND,
        params: { skill: 'search', message: 'hi' },
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result?: { state: string } };
    expect(json.result?.state).toBe('completed');
  });
});

describe('SSE connection cap (plan T1.4)', () => {
  it('rejects a new connection once the concurrent cap is reached', async () => {
    const target = makeAgent(TARGET_ID);
    const sheet = { skills: ['search'] };
    const counter = { runs: 0 };
    const taskStore = new InMemoryA2aTaskStore();

    const service = createA2aRpcService({
      getIdentity: stubIdentity(target, sheet),
      peerStore: newPeerStore(),
      runner: countingRunner(HELLO_SCRIPT, counter),
      taskStore,
      maxSseConnections: 2,
    });

    const a = service.acquireSseSlot();
    const b = service.acquireSseSlot();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    // Third slot is over the cap.
    expect(service.acquireSseSlot()).toBeNull();

    // Releasing one frees capacity again.
    a?.release();
    expect(service.acquireSseSlot()).not.toBeNull();
  });

  it('is a distinct gate from the rate limiter — both run at route entry', async () => {
    const target = makeAgent(TARGET_ID);
    const sheet = { skills: ['search'] };
    const counter = { runs: 0 };
    const preAuthLimiter = new MemoryA2aPreAuthLimiter({ maxPerWindow: 1000, now: () => 0 });
    const service = createA2aRpcService({
      getIdentity: stubIdentity(target, sheet),
      peerStore: newPeerStore(),
      runner: countingRunner(HELLO_SCRIPT, counter),
      taskStore: new InMemoryA2aTaskStore(),
      maxSseConnections: 1,
      preAuthLimiter,
    });

    expect(service.checkPreAuth('some-ip')).toBe(true);
    const slot = service.acquireSseSlot();
    expect(slot).not.toBeNull();
    // Pre-auth still passes (plenty of budget) even though the SSE cap is hit.
    expect(service.checkPreAuth('some-ip')).toBe(true);
    expect(service.acquireSseSlot()).toBeNull();
  });
});
