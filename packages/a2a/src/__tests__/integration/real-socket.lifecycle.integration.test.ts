// T1.8 acceptance gate — the full A2A peering lifecycle over REAL sockets:
// handshake -> message/send (sync) -> async submit -> poll -> SSE subscribe ->
// revoke -> rejected send after revocation. Two real Ethos A2A servers, two
// real ephemeral ports, one real `A2aOutboundClient` driving both from the
// outside. See `harness.ts`'s header for why this differs from the
// `app.request()` suites everywhere else in `packages/a2a/src/__tests__/`.
//
// Slow by nature (two real HTTP servers per test) — run via `pnpm
// test:integration`, never part of the default `pnpm test`. See
// `vitest.integration.config.ts` at the repo root.

import { decodeJwt } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { signStruct } from '../../crypto';
import { A2aOutboundClient } from '../../outbound';
import {
  A2A_METHOD_TASKS_SUBSCRIBE,
  A2A_REQUEST_POP_CONTEXT,
  A2A_RPC_AUTH_ERROR_CODES,
} from '../../rpc';
import {
  approvePeer,
  echoRunner,
  type RealAgentServer,
  revokePeer,
  startAgentServer,
} from './harness';

/** Repeatedly re-send the SAME idempotency key until the task settles. */
async function pollUntilTerminal(
  client: A2aOutboundClient,
  args: Parameters<A2aOutboundClient['sendMessage']>[0],
  maxAttempts = 50,
  intervalMs = 20,
): Promise<{ ok: true; mode: 'async'; taskId: string; status: string }> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await client.sendMessage(args);
    if (!res.ok) throw new Error(`poll: unexpected JSON-RPC error ${res.code} ${res.message}`);
    if (res.mode !== 'async') throw new Error('poll: expected an async result');
    if (res.status === 'completed' || res.status === 'failed') return res;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`poll: task did not settle within ${maxAttempts * intervalMs}ms`);
}

describe('A2A real-socket lifecycle (plan T1.8)', () => {
  const servers: RealAgentServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  it('handshake -> sync send -> async submit -> poll -> SSE subscribe -> revoke -> send-after-revoke rejected', async () => {
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

    // Human-anchor step: approve the initiator on the responder's allowlist.
    await approvePeer(responder, initiator.fingerprint, ['echo']);

    const client = new A2aOutboundClient();

    // --- handshake ---------------------------------------------------------
    const session = await client.connect({
      wellKnownUrl: responder.wellKnownUrl,
      myCard: initiator.card,
      myPrivateKeyPem: initiator.privateKeyPem,
    });
    expect(session.token).toEqual(expect.any(String));
    expect(session.peerCard.keyFingerprint).toBe(responder.fingerprint);

    // --- message/send (sync) ------------------------------------------------
    const syncResult = await client.sendMessage({
      session,
      myPrivateKeyPem: initiator.privateKeyPem,
      skill: 'echo',
      message: 'hello over a real socket',
      mode: 'sync',
    });
    expect(syncResult.ok).toBe(true);
    if (syncResult.ok && syncResult.mode === 'sync') {
      expect(syncResult.state).toBe('completed');
      expect(syncResult.text).toBe('echo: hello over a real socket');
    }

    // --- async submit --------------------------------------------------------
    const submitArgs = {
      session,
      myPrivateKeyPem: initiator.privateKeyPem,
      skill: 'echo',
      message: 'do it in the background',
      mode: 'async' as const,
      idempotencyKey: 'real-socket-async-1',
    };
    const submitted = await client.sendMessage(submitArgs);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok || submitted.mode !== 'async')
      throw new Error('expected async submit result');
    const taskId = submitted.taskId;

    // --- poll (re-send the SAME idempotency key until it settles) -----------
    const polled = await pollUntilTerminal(client, submitArgs);
    expect(polled.taskId).toBe(taskId);
    expect(polled.status).toBe('completed');

    // --- SSE subscribe --------------------------------------------------------
    // The task is already terminal, so the real stream writes once and closes
    // immediately (mirrors `sse.test.ts`'s in-process assertion, over a real
    // socket this time).
    const jti = decodeJwt(session.token).jti;
    if (typeof jti !== 'string') throw new Error('session token missing jti');
    const ts = Date.now();
    const sseRes = await fetch(`${responder.baseUrl}/a2a/${responder.id}/tasks/${taskId}/events`, {
      headers: {
        authorization: `Bearer ${session.token}`,
        'x-a2a-pop': signStruct(
          {
            context: A2A_REQUEST_POP_CONTEXT,
            method: A2A_METHOD_TASKS_SUBSCRIBE,
            jti,
            timestamp: ts,
          },
          initiator.privateKeyPem,
        ),
        'x-a2a-pop-timestamp': String(ts),
      },
    });
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get('content-type')).toContain('text/event-stream');
    const sseBody = await sseRes.text();
    expect(sseBody).toContain('completed');
    expect(sseBody).toContain('echo: do it in the background');

    // --- revoke -----------------------------------------------------------
    await revokePeer(responder, initiator.fingerprint);

    // --- send after revocation is rejected -----------------------------------
    const rejected = await client.sendMessage({
      session,
      myPrivateKeyPem: initiator.privateKeyPem,
      skill: 'echo',
      message: 'should not go through',
      mode: 'sync',
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe(A2A_RPC_AUTH_ERROR_CODES.UNAUTHORIZED);
  }, 20_000);
});
