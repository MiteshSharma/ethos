// T1.8 acceptance gate — T0.3 (outbound timeout) and T1.3 (retry with backoff)
// asserted against REAL sockets: a listener that accepts a connection and
// never responds, and a raw TCP gate that resets the first N connections
// before letting a real server answer. The existing unit-level coverage for
// both (`outbound.test.ts`) stubs `fetchImpl` — this file is the real-socket
// complement the plan calls for, not a replacement.
//
// Slow by nature — run via `pnpm test:integration`, never part of the default
// `pnpm test`. See `vitest.integration.config.ts` at the repo root.

import { afterEach, describe, expect, it } from 'vitest';
import { A2aOutboundClient, A2aOutboundError, computeA2aBackoffDelayMs } from '../../outbound';
import { approvePeer, echoRunner, type RealAgentServer, startAgentServer } from './harness';
import {
  type FailNTimesThenProxy,
  type HangingListener,
  startFailNTimesThenProxy,
  startHangingListener,
} from './net-helpers';

describe('A2A real-socket timeouts (plan T0.3)', () => {
  const servers: RealAgentServer[] = [];
  const listeners: HangingListener[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
    await Promise.all(listeners.splice(0).map((l) => l.close()));
  });

  it('sendMessage: a real listener that accepts and never responds fails within the configured budget, not by hanging', async () => {
    const initiator = await startAgentServer({
      id: 'initiator',
      skills: [],
      runner: echoRunner(''),
    });
    const responder = await startAgentServer({
      id: 'responder',
      skills: ['echo'],
      runner: echoRunner('echo: '),
    });
    servers.push(initiator, responder);
    await approvePeer(responder, initiator.fingerprint, ['echo']);

    // The handshake goes to the REAL responder — only the `message/send` POST
    // under test is redirected to the hanging listener.
    const client = new A2aOutboundClient();
    const session = await client.connect({
      wellKnownUrl: responder.wellKnownUrl,
      myCard: initiator.card,
      myPrivateKeyPem: initiator.privateKeyPem,
    });

    const hanging = await startHangingListener();
    listeners.push(hanging);

    // sendMaxAttempts: 1 isolates the raw timeout from T1.3's retry loop
    // (covered separately below), same as the stubbed unit test does.
    const timeoutClient = new A2aOutboundClient({ sendTimeoutMs: 100, sendMaxAttempts: 1 });

    const started = Date.now();
    let thrown: unknown;
    try {
      await timeoutClient.sendMessage({
        session,
        jsonRpcUrl: hanging.url,
        myPrivateKeyPem: initiator.privateKeyPem,
        skill: 'echo',
        message: 'hello?',
      });
    } catch (err) {
      thrown = err;
    }
    const elapsed = Date.now() - started;

    expect(thrown).toBeInstanceOf(A2aOutboundError);
    if (thrown instanceof A2aOutboundError) expect(thrown.code).toBe('fetch_failed');
    // Bounded by the configured budget, not by "never" — a real socket that
    // never writes would hang forever without T0.3's `AbortSignal.timeout`.
    expect(elapsed).toBeLessThan(5_000);
    expect(elapsed).toBeGreaterThanOrEqual(90);
  }, 15_000);
});

describe('A2A real-socket retry with backoff + jitter (plan T1.3)', () => {
  const servers: RealAgentServer[] = [];
  const proxies: FailNTimesThenProxy[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
    await Promise.all(proxies.splice(0).map((p) => p.close()));
  });

  it('delivers on attempt 3 after two REAL transport failures, delays following the backoff schedule', async () => {
    const initiator = await startAgentServer({
      id: 'initiator',
      skills: [],
      runner: echoRunner(''),
    });
    const responder = await startAgentServer({
      id: 'responder',
      skills: ['echo'],
      runner: echoRunner('echo: '),
    });
    servers.push(initiator, responder);
    await approvePeer(responder, initiator.fingerprint, ['echo']);

    const connectClient = new A2aOutboundClient();
    const session = await connectClient.connect({
      wellKnownUrl: responder.wellKnownUrl,
      myCard: initiator.card,
      myPrivateKeyPem: initiator.privateKeyPem,
    });

    // A real TCP gate: the first 2 connections are reset (genuine transport
    // failures), the 3rd is piped to the real responder.
    const proxy = await startFailNTimesThenProxy(responder.port, 2);
    proxies.push(proxy);

    const sleeps: number[] = [];
    const client = new A2aOutboundClient({
      randomFn: () => 0.5,
      // Injected so the test doesn't spend real wall-clock time sleeping — the
      // FAILURE and the eventual SUCCESS are both real socket I/O; only the
      // backoff delay itself is sped up, exactly as `A2aOutboundClientDeps`
      // documents `sleepFn` for.
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await client.sendMessage({
      session,
      jsonRpcUrl: `${proxy.url}a2a/${responder.id}`,
      myPrivateKeyPem: initiator.privateKeyPem,
      skill: 'echo',
      message: 'hi',
      mode: 'sync',
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.mode === 'sync') expect(result.text).toBe('echo: hi');
    expect(proxy.attempts()).toBe(3);
    // Full jitter, randomFn fixed at 0.5: window = min(cap, base * 2^attempt).
    expect(sleeps).toEqual([
      computeA2aBackoffDelayMs(0, 500, 30_000, () => 0.5),
      computeA2aBackoffDelayMs(1, 500, 30_000, () => 0.5),
    ]);
  }, 15_000);

  it('exhausts the retry budget against a peer that never comes back — not before, not forever', async () => {
    const initiator = await startAgentServer({
      id: 'initiator',
      skills: [],
      runner: echoRunner(''),
    });
    const responder = await startAgentServer({
      id: 'responder',
      skills: ['echo'],
      runner: echoRunner('echo: '),
    });
    servers.push(initiator, responder);
    await approvePeer(responder, initiator.fingerprint, ['echo']);

    const connectClient = new A2aOutboundClient();
    const session = await connectClient.connect({
      wellKnownUrl: responder.wellKnownUrl,
      myCard: initiator.card,
      myPrivateKeyPem: initiator.privateKeyPem,
    });

    // Fails every attempt — the "success" cutover never arrives.
    const proxy = await startFailNTimesThenProxy(responder.port, Number.POSITIVE_INFINITY);
    proxies.push(proxy);

    const sleeps: number[] = [];
    const client = new A2aOutboundClient({
      randomFn: () => 0.5,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      sendMaxAttempts: 4,
    });

    let thrown: unknown;
    try {
      await client.sendMessage({
        session,
        jsonRpcUrl: `${proxy.url}a2a/${responder.id}`,
        myPrivateKeyPem: initiator.privateKeyPem,
        skill: 'echo',
        message: 'hi',
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(A2aOutboundError);
    if (thrown instanceof A2aOutboundError) expect(thrown.code).toBe('fetch_failed');
    expect(proxy.attempts()).toBe(4);
    // 3 delays between 4 attempts; no delay after the final exhausted attempt.
    expect(sleeps).toEqual([
      computeA2aBackoffDelayMs(0, 500, 30_000, () => 0.5),
      computeA2aBackoffDelayMs(1, 500, 30_000, () => 0.5),
      computeA2aBackoffDelayMs(2, 500, 30_000, () => 0.5),
    ]);
  }, 15_000);
});
