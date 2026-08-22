// Phase 7 acceptance gate — the OUTBOUND client driven against a REAL in-process
// server (the same auth + rpc routers the inbound phases ship). No network: the
// client's `fetchImpl` dispatches into a Hono app via `app.request`.
//
// Covered:
//   (a) full round-trip — connect (fetch card + handshake) → sendMessage(sync).
//   (b) delegation containment — the client signs depth+1 and the rpc server
//       admits it; a second call exhausts the fan-out budget → the client throws
//       `fanout_exhausted` and makes NO HTTP call.
// Stolen/wrong-key attacks are covered server-side (auth/rpc tests); not repeated.

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createA2aAuthRouter } from '../auth';
import { A2aDelegationGuard } from '../delegation';
import { A2aOutboundClient, A2aOutboundError, computeA2aBackoffDelayMs } from '../outbound';
import { createA2aRpcRouter } from '../rpc';
import { MemoryNonceStore, type PeerGrant } from '../stores';
import { createA2aWellKnownRouter } from '../well-known';
import {
  type Agent,
  countingRunner,
  HELLO_SCRIPT,
  makeAgent,
  newPeerStore,
  type SheetHolder,
  stubAllowlist,
  stubIdentity,
  stubSecrets,
  TARGET_ID,
} from './a2a-fixtures';

const WELL_KNOWN_URL = `http://localhost:8787/.well-known/agent-card.json?personality=${TARGET_ID}`;

function toUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Assemble a real server for `target`, approving `initiator` on the allowlist.
 * The auth + rpc routers share ONE peer store so the handshake-minted token is
 * validatable by the rpc gate. Returns the Hono app + the counting runner state.
 */
function makeServer(
  target: Agent,
  initiator: Agent,
  sheet: SheetHolder,
  clock: { t: number },
  opts: { rpcGuard?: A2aDelegationGuard } = {},
) {
  const peerStore = newPeerStore();
  const counter = { runs: 0 };
  const approved = new Map<string, PeerGrant>([
    [
      initiator.fingerprint,
      { fingerprint: initiator.fingerprint, scope: ['search'], enabled: true },
    ],
  ]);

  const app = new Hono();
  app.route(
    '/a2a-auth',
    createA2aAuthRouter({
      secrets: stubSecrets({ [`a2a/${target.id}/private-key`]: target.privateKeyPem }),
      allowlist: stubAllowlist(approved),
      peerStore,
      nonces: new MemoryNonceStore({ now: () => clock.t }),
      now: () => clock.t,
    }),
  );
  app.route(
    '/a2a',
    createA2aRpcRouter({
      getIdentity: stubIdentity(target, sheet),
      peerStore,
      runner: countingRunner(HELLO_SCRIPT, counter),
      now: () => clock.t,
      ...(opts.rpcGuard ? { delegationGuard: opts.rpcGuard } : {}),
    }),
  );
  app.route('/', createA2aWellKnownRouter({ getIdentity: stubIdentity(target, sheet) }));

  return { app, counter };
}

describe('A2aOutboundClient — full round-trip (handshake → sync task)', () => {
  it('connects, verifies the card, handshakes for a token, and gets the echoed result', async () => {
    const target = makeAgent(TARGET_ID);
    const initiator = makeAgent('initiator');
    const sheet: SheetHolder = { skills: ['search'] };
    const clock = { t: Date.now() };
    const { app, counter } = makeServer(target, initiator, sheet, clock);

    const fetchImpl: typeof fetch = async (input, init) => app.request(toUrl(input), init);
    const client = new A2aOutboundClient({ fetchImpl, now: () => clock.t });

    const session = await client.connect({
      wellKnownUrl: WELL_KNOWN_URL,
      expectedFingerprint: target.fingerprint,
      myCard: initiator.card,
      myPrivateKeyPem: initiator.privateKeyPem,
    });
    expect(session.peerCard.id).toBe(TARGET_ID);
    expect(session.token).toBeTruthy();

    const res = await client.sendMessage({
      session,
      myPrivateKeyPem: initiator.privateKeyPem,
      skill: 'search',
      message: 'hi',
    });

    expect(res.ok).toBe(true);
    if (res.ok && res.mode === 'sync') {
      expect(res.state).toBe('completed');
      expect(res.text).toBe('hello world');
    }
    expect(counter.runs).toBe(1);
  });

  it('maps a JSON-RPC error (out-of-scope skill) to { ok:false, code }', async () => {
    const target = makeAgent(TARGET_ID);
    const initiator = makeAgent('initiator');
    const sheet: SheetHolder = { skills: ['search'] };
    const clock = { t: Date.now() };
    const { app } = makeServer(target, initiator, sheet, clock);

    const fetchImpl: typeof fetch = async (input, init) => app.request(toUrl(input), init);
    const client = new A2aOutboundClient({ fetchImpl, now: () => clock.t });
    const session = await client.connect({
      wellKnownUrl: WELL_KNOWN_URL,
      myCard: initiator.card,
      myPrivateKeyPem: initiator.privateKeyPem,
    });

    // `write` is not in the granted scope → FORBIDDEN_SCOPE (-32003).
    const res = await client.sendMessage({
      session,
      myPrivateKeyPem: initiator.privateKeyPem,
      skill: 'write',
      message: 'hi',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(-32003);
  });
});

describe('A2aOutboundClient — outbound fetch timeouts (plan T0.3)', () => {
  /** A `fetch` that hangs until its `AbortSignal` fires, then rejects — like a peer that accepted the connection and never responded. */
  const hangingFetch: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason));
    });

  it('sendMessage: a peer that never responds fails within the configured budget, not by hanging', async () => {
    const target = makeAgent(TARGET_ID);
    const initiator = makeAgent('initiator');
    const sheet: SheetHolder = { skills: ['search'] };
    const clock = { t: Date.now() };
    const { app } = makeServer(target, initiator, sheet, clock);

    // connect() over the REAL server (fast, separate client) — only the
    // `message/send` fetch under test hangs.
    const connectClient = new A2aOutboundClient({
      fetchImpl: async (input, init) => app.request(toUrl(input), init),
      now: () => clock.t,
    });
    const session = await connectClient.connect({
      wellKnownUrl: WELL_KNOWN_URL,
      myCard: initiator.card,
      myPrivateKeyPem: initiator.privateKeyPem,
    });

    // T1.3 retry is a SEPARATE lane (see below) — isolate the raw timeout
    // mechanic here with `sendMaxAttempts: 1` so this test's budget doesn't
    // have to account for backoff delays between attempts.
    const client = new A2aOutboundClient({
      fetchImpl: hangingFetch,
      now: () => clock.t,
      sendTimeoutMs: 20,
      sendMaxAttempts: 1,
    });

    const started = Date.now();
    let thrown: unknown;
    try {
      await client.sendMessage({
        session,
        myPrivateKeyPem: initiator.privateKeyPem,
        skill: 'search',
        message: 'hi',
      });
    } catch (err) {
      thrown = err;
    }
    const elapsed = Date.now() - started;

    expect(thrown).toBeInstanceOf(A2aOutboundError);
    if (thrown instanceof A2aOutboundError) expect(thrown.code).toBe('fetch_failed');
    // Bounded by the configured timeout, not by "never" — well under a
    // hang-forever failure mode even with test scheduling slack.
    expect(elapsed).toBeLessThan(2000);
  });

  it('connect: a peer that never responds to the handshake fails within the configured budget, not by hanging', async () => {
    const initiator = makeAgent('initiator');

    // The initial card fetch (fetchAndVerifyCard, GET) succeeds; the
    // handshake POSTs (challenge/response) hang. Isolates the handshake
    // timeout (postJson) from the card-fetch step, which T0.3 does not touch.
    const target = makeAgent(TARGET_ID);
    const sheet: SheetHolder = { skills: [] };
    const clock = { t: Date.now() };
    const { app } = makeServer(target, initiator, sheet, clock);
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = toUrl(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/a2a-auth/')) {
        return hangingFetch(input, init);
      }
      return app.request(url, init);
    };
    const client = new A2aOutboundClient({
      fetchImpl,
      now: () => clock.t,
      handshakeTimeoutMs: 20,
    });

    const started = Date.now();
    let thrown: unknown;
    try {
      await client.connect({
        wellKnownUrl: WELL_KNOWN_URL,
        myCard: initiator.card,
        myPrivateKeyPem: initiator.privateKeyPem,
      });
    } catch (err) {
      thrown = err;
    }
    const elapsed = Date.now() - started;

    expect(thrown).toBeInstanceOf(A2aOutboundError);
    if (thrown instanceof A2aOutboundError) expect(thrown.code).toBe('fetch_failed');
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('A2aOutboundClient — retry with backoff + jitter (plan T1.3)', () => {
  it('delivers on attempt 3 after two transport failures, delays following the backoff schedule', async () => {
    const target = makeAgent(TARGET_ID);
    const initiator = makeAgent('initiator');
    const sheet: SheetHolder = { skills: ['search'] };
    const clock = { t: Date.now() };
    const { app, counter } = makeServer(target, initiator, sheet, clock);

    // The first two `message/send` POSTs fail at the transport level; the
    // third reaches the real server. Connect()'s handshake is untouched.
    let rpcAttempts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = toUrl(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/a2a/')) {
        rpcAttempts += 1;
        if (rpcAttempts < 3) throw new Error('simulated transport failure');
      }
      return app.request(url, init);
    };

    const sleeps: number[] = [];
    const client = new A2aOutboundClient({
      fetchImpl,
      now: () => clock.t,
      randomFn: () => 0.5,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    const session = await client.connect({
      wellKnownUrl: WELL_KNOWN_URL,
      myCard: initiator.card,
      myPrivateKeyPem: initiator.privateKeyPem,
    });

    const res = await client.sendMessage({
      session,
      myPrivateKeyPem: initiator.privateKeyPem,
      skill: 'search',
      message: 'hi',
    });

    expect(res.ok).toBe(true);
    expect(rpcAttempts).toBe(3);
    expect(counter.runs).toBe(1);
    // Full jitter with randomFn fixed at 0.5: window = min(cap, base*2^attempt).
    // attempt 0 (after 1st failure): 0.5 * 500  = 250
    // attempt 1 (after 2nd failure): 0.5 * 1000 = 500
    expect(sleeps).toEqual([250, 500]);
  });

  it('exhausts the retry budget and fails — not before, not by retrying forever', async () => {
    const target = makeAgent(TARGET_ID);
    const initiator = makeAgent('initiator');
    const sheet: SheetHolder = { skills: ['search'] };
    const clock = { t: Date.now() };
    const { app, counter } = makeServer(target, initiator, sheet, clock);

    let rpcAttempts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = toUrl(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/a2a/')) {
        rpcAttempts += 1;
        throw new Error('simulated permanent transport failure');
      }
      return app.request(url, init);
    };

    const sleeps: number[] = [];
    const client = new A2aOutboundClient({
      fetchImpl,
      now: () => clock.t,
      randomFn: () => 0.5,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      sendMaxAttempts: 4,
    });
    const session = await client.connect({
      wellKnownUrl: WELL_KNOWN_URL,
      myCard: initiator.card,
      myPrivateKeyPem: initiator.privateKeyPem,
    });

    let thrown: unknown;
    try {
      await client.sendMessage({
        session,
        myPrivateKeyPem: initiator.privateKeyPem,
        skill: 'search',
        message: 'hi',
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(A2aOutboundError);
    if (thrown instanceof A2aOutboundError) expect(thrown.code).toBe('fetch_failed');
    // Exactly the configured budget — not before, not forever.
    expect(rpcAttempts).toBe(4);
    expect(counter.runs).toBe(0);
    // 3 delays between 4 attempts; no delay after the final exhausted attempt.
    expect(sleeps).toEqual([250, 500, 1000]);
  });

  it('does NOT retry a JSON-RPC error response — the peer answered; retrying would not change it', async () => {
    const target = makeAgent(TARGET_ID);
    const initiator = makeAgent('initiator');
    const sheet: SheetHolder = { skills: ['search'] };
    const clock = { t: Date.now() };
    const { app } = makeServer(target, initiator, sheet, clock);

    let rpcAttempts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = toUrl(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/a2a/')) rpcAttempts += 1;
      return app.request(url, init);
    };
    const client = new A2aOutboundClient({ fetchImpl, now: () => clock.t });
    const session = await client.connect({
      wellKnownUrl: WELL_KNOWN_URL,
      myCard: initiator.card,
      myPrivateKeyPem: initiator.privateKeyPem,
    });

    // `write` is out of the granted scope → a real FORBIDDEN_SCOPE answer.
    const res = await client.sendMessage({
      session,
      myPrivateKeyPem: initiator.privateKeyPem,
      skill: 'write',
      message: 'hi',
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(-32003);
    expect(rpcAttempts).toBe(1);
  });
});

describe('computeA2aBackoffDelayMs — full-jitter schedule', () => {
  it('scales the window exponentially, caps it, and samples uniformly via randomFn', () => {
    expect(computeA2aBackoffDelayMs(0, 500, 30_000, () => 0)).toBe(0);
    expect(computeA2aBackoffDelayMs(0, 500, 30_000, () => 0.5)).toBe(250);
    expect(computeA2aBackoffDelayMs(1, 500, 30_000, () => 0.5)).toBe(500); // window 1000
    expect(computeA2aBackoffDelayMs(2, 500, 30_000, () => 0.5)).toBe(1000); // window 2000
    // Once base*2^attempt exceeds cap, the window is capped rather than growing forever.
    expect(computeA2aBackoffDelayMs(10, 500, 30_000, () => 0.5)).toBe(15_000);
    expect(computeA2aBackoffDelayMs(10, 500, 30_000, () => 0.999999)).toBeLessThan(30_000);
  });
});

describe('A2aOutboundClient — egress default-deny (plan §15)', () => {
  it('refuses a non-approved peer with egress_denied and does NO handshake', async () => {
    const target = makeAgent(TARGET_ID);
    const initiator = makeAgent('initiator');
    const sheet: SheetHolder = { skills: ['search'] };
    const clock = { t: Date.now() };
    const { app, counter } = makeServer(target, initiator, sheet, clock);

    // Count challenge POSTs — the first handshake step. A refused egress must
    // never reach it.
    let authPosts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = toUrl(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/a2a-auth/')) authPosts += 1;
      return app.request(url, init);
    };
    const client = new A2aOutboundClient({ fetchImpl, now: () => clock.t });

    let thrown: unknown;
    try {
      await client.connect({
        wellKnownUrl: WELL_KNOWN_URL,
        expectedFingerprint: target.fingerprint,
        myCard: initiator.card,
        myPrivateKeyPem: initiator.privateKeyPem,
        egressCheck: () => false,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(A2aOutboundError);
    if (thrown instanceof A2aOutboundError) expect(thrown.code).toBe('egress_denied');
    // The card was fetched + verified, but NO handshake was attempted, no run ran.
    expect(authPosts).toBe(0);
    expect(counter.runs).toBe(0);
  });

  it('admits an approved peer and completes the handshake', async () => {
    const target = makeAgent(TARGET_ID);
    const initiator = makeAgent('initiator');
    const sheet: SheetHolder = { skills: ['search'] };
    const clock = { t: Date.now() };
    const { app } = makeServer(target, initiator, sheet, clock);
    const fetchImpl: typeof fetch = async (input, init) => app.request(toUrl(input), init);
    const client = new A2aOutboundClient({ fetchImpl, now: () => clock.t });

    const seen: string[] = [];
    const session = await client.connect({
      wellKnownUrl: WELL_KNOWN_URL,
      expectedFingerprint: target.fingerprint,
      myCard: initiator.card,
      myPrivateKeyPem: initiator.privateKeyPem,
      egressCheck: (fp) => {
        seen.push(fp);
        return true;
      },
    });
    expect(session.token).toBeTruthy();
    // The egress gate saw the VERIFIED peer fingerprint.
    expect(seen).toEqual([target.fingerprint]);
  });
});

describe('A2aOutboundClient — delegation containment (P8)', () => {
  it('signs depth+1 (admitted by the server), then throws fanout_exhausted with NO HTTP call', async () => {
    const target = makeAgent(TARGET_ID);
    const initiator = makeAgent('initiator');
    const sheet: SheetHolder = { skills: ['search'] };
    const clock = { t: Date.now() };
    // The server's own guard (responder side) admits the depth-1 envelope.
    const { app, counter } = makeServer(target, initiator, sheet, clock, {
      rpcGuard: new A2aDelegationGuard(),
    });

    // The initiator's fan-out guard — a distinct process/instance from the
    // server's. Budget 1: exactly one onward call is allowed under the trace.
    const initiatorGuard = new A2aDelegationGuard({ fanOutBudget: 1 });
    const traceId = 'trace-out';

    const rpcHeaders: Headers[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = toUrl(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/a2a/')) {
        rpcHeaders.push(new Headers(init?.headers));
      }
      return app.request(url, init);
    };
    const client = new A2aOutboundClient({ fetchImpl, now: () => clock.t });
    const session = await client.connect({
      wellKnownUrl: WELL_KNOWN_URL,
      myCard: initiator.card,
      myPrivateKeyPem: initiator.privateKeyPem,
    });

    const delegation = {
      traceId,
      depth: 0,
      reserveOutbound: () => initiatorGuard.reserveOutbound(traceId),
    };

    // First onward call — reserves the budget, signs depth+1, server admits.
    const first = await client.sendMessage({
      session,
      myPrivateKeyPem: initiator.privateKeyPem,
      skill: 'search',
      message: 'hi',
      delegation,
    });
    expect(first.ok).toBe(true);
    expect(counter.runs).toBe(1);
    expect(rpcHeaders).toHaveLength(1);
    const headers = rpcHeaders[0] ?? new Headers();
    expect(headers.get('x-a2a-trace-id')).toBe(traceId);
    expect(headers.get('x-a2a-delegation-depth')).toBe('1');
    expect(headers.get('x-a2a-delegation-sig')).not.toBeNull();

    // Second onward call — budget exhausted → throw BEFORE any HTTP.
    let thrown: unknown;
    try {
      await client.sendMessage({
        session,
        myPrivateKeyPem: initiator.privateKeyPem,
        skill: 'search',
        message: 'hi again',
        delegation,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(A2aOutboundError);
    if (thrown instanceof A2aOutboundError) expect(thrown.code).toBe('fanout_exhausted');
    // No second HTTP call, no second runner invocation.
    expect(rpcHeaders).toHaveLength(1);
    expect(counter.runs).toBe(1);
  });
});
