// Correctness fix acceptance gate — Bug 1 (idempotency across a T1.3 retry).
//
// Before this fix, `A2aOutboundClient.sendMessage` never guaranteed a STABLE
// idempotency key across retries of the SAME logical send when the caller
// omitted one (as `extensions/tools-a2a`'s `a2a_send` does): the SYNC path had
// no dedupe at all, and the ASYNC path's server-side fallback
// (`params.idempotencyKey ?? randomUUID()`) minted a FRESH key per HTTP call,
// so a retry's key never matched the first attempt's. The fix mints the key
// ONCE in `sendMessage`, before the retry loop, and (for sync) makes the
// server actually persist + look up a result keyed on it.
//
// Both tests below reproduce the exact failure mode from the bug report: the
// peer ACTUALLY completes the turn on attempt 1, but the response never makes
// it back to the initiator (a dropped/timed-out response, not a request that
// never arrived) — the scenario a naive "did my request arrive" retry cannot
// distinguish from "the peer never saw it at all". A correct retry must not
// re-run the turn either way.

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createA2aAuthRouter } from '../auth';
import { A2aOutboundClient } from '../outbound';
import { createA2aRpcRouter } from '../rpc';
import { MemoryNonceStore, type PeerGrant } from '../stores';
import { InMemoryA2aTaskStore } from '../task-store';
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

/** Same shape as `outbound.test.ts`'s `makeServer`, plus a task store so the
 * sync path's idempotency dedupe (Bug 1's server-side half) is exercised. */
function makeServer(target: Agent, initiator: Agent, sheet: SheetHolder, clock: { t: number }) {
  const peerStore = newPeerStore();
  const counter = { runs: 0 };
  const taskStore = new InMemoryA2aTaskStore();
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
      taskStore,
      now: () => clock.t,
    }),
  );
  app.route('/', createA2aWellKnownRouter({ getIdentity: stubIdentity(target, sheet) }));

  return { app, counter };
}

describe('A2aOutboundClient — sync retry does not double-execute the agent turn (Bug 1)', () => {
  it('a retry after the peer already completed the turn returns the cached result, runs EXACTLY once', async () => {
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
        if (rpcAttempts === 1) {
          // The peer actually runs the turn to completion on attempt 1 — but
          // the RESPONSE never makes it back (the T1.3 "30s timeout after the
          // peer already started" scenario, not a request that never arrived).
          await app.request(url, init);
          throw new Error('simulated: response lost after the peer completed the turn');
        }
      }
      return app.request(url, init);
    };

    const client = new A2aOutboundClient({
      fetchImpl,
      now: () => clock.t,
      sleepFn: async () => {},
    });
    const session = await client.connect({
      wellKnownUrl: WELL_KNOWN_URL,
      myCard: initiator.card,
      myPrivateKeyPem: initiator.privateKeyPem,
    });

    // No `idempotencyKey` supplied — exactly what `extensions/tools-a2a`'s
    // `a2a_send` does today. Before the fix this had ZERO dedupe protection.
    const res = await client.sendMessage({
      session,
      myPrivateKeyPem: initiator.privateKeyPem,
      skill: 'search',
      message: 'hi',
    });

    expect(res.ok).toBe(true);
    expect(rpcAttempts).toBe(2);
    expect(counter.runs).toBe(1); // NOT double-executed
    if (res.ok && res.mode === 'sync') {
      expect(res.state).toBe('completed');
      expect(res.text).toBe('hello world');
    }
  });
});

describe('A2aOutboundClient — async retry does not double-execute the agent turn (Bug 1)', () => {
  it('a retried async submit with no caller-supplied key still dedupes across the retry', async () => {
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
        if (rpcAttempts === 1) {
          // Attempt 1's ack ("submitted") reaches the server and is accepted,
          // but the response back to the initiator is lost.
          await app.request(url, init);
          throw new Error('simulated: response lost after the peer accepted the submission');
        }
      }
      return app.request(url, init);
    };

    const client = new A2aOutboundClient({
      fetchImpl,
      now: () => clock.t,
      sleepFn: async () => {},
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
      mode: 'async',
    });

    expect(res.ok).toBe(true);
    expect(rpcAttempts).toBe(2);
    if (res.ok && res.mode === 'async') {
      expect(res.taskId).toBeTruthy();
    }
    // Give the background run a moment to settle, then confirm it ran once.
    await new Promise((r) => setTimeout(r, 10));
    expect(counter.runs).toBe(1);
  });
});
