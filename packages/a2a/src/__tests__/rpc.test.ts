// Phase 5 acceptance gate — the JSON-RPC `/a2a` endpoint (plan §5/§10/§12).
//
// Every attack below MUST be rejected with a JSON-RPC error; the happy path
// MUST consume the injected runner's AgentEvent stream and return the assistant
// result. The three gates — token, per-request PoP, scope ∩ current sheet — are
// exercised directly (no HTTP) plus one end-to-end HTTP round-trip that stitches
// the well-known card, the Phase-4 handshake, and this endpoint together.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  A2aIdentityProvider,
  AgentCard,
  AgentEvent,
  SecretRef,
  SecretsResolver,
} from '@ethosagent/types';
import { EthosError } from '@ethosagent/types';
import { Hono } from 'hono';
import { decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';
import { createA2aAuthRouter } from '../auth';
import { fetchAndVerifyCard } from '../client';
import { buildDidDocument, fingerprint, generateEd25519, signCard, signStruct } from '../crypto';
import {
  A2A_METHOD_MESSAGE_SEND,
  type A2aRequestCredentials,
  type A2aTaskResult,
  type A2aTaskRunner,
  createA2aRpcRouter,
  createA2aRpcService,
  type JsonRpcResponse,
} from '../rpc';
import {
  type A2aAllowlist,
  MemoryNonceStore,
  type PeerGrant,
  StorageA2aPeerStore,
} from '../stores';
import { mintToken } from '../tokens';
import { createA2aWellKnownRouter } from '../well-known';

// --- Test agents -----------------------------------------------------------

interface Agent {
  id: string;
  privateKeyPem: string;
  rawPublicKey: Buffer;
  fingerprint: string;
  /** Unsigned card fields (skills empty) — the identity stub re-signs per audience. */
  unsigned: Omit<AgentCard, 'signature'>;
  card: AgentCard;
}

function makeAgent(id: string): Agent {
  const { privateKeyPem, rawPublicKey } = generateEd25519();
  const fp = fingerprint(rawPublicKey);
  const jsonRpc = `http://localhost:8787/a2a/${id}`;
  const unsigned: Omit<AgentCard, 'signature'> = {
    id,
    name: id,
    description: `Agent ${id}.`,
    protocolVersion: 'a2a/0.1',
    skills: [],
    endpoints: { jsonRpc, auth: `http://localhost:8787/a2a-auth/${id}` },
    publicKey: rawPublicKey.toString('base64'),
    keyFingerprint: fp,
    signatureAlg: 'ed25519',
    did: buildDidDocument(rawPublicKey, jsonRpc),
  };
  return {
    id,
    privateKeyPem,
    rawPublicKey,
    fingerprint: fp,
    unsigned,
    card: { ...unsigned, signature: signCard(unsigned, privateKeyPem) },
  };
}

// A mutable "current character sheet" — the source the identity provider reads
// AT CALL TIME, so a test can revoke a skill mid-flight.
interface SheetHolder {
  skills: string[];
}

/**
 * A signing identity provider: `stranger` → no skills; `trusted-peer`/`internal`
 * → the CURRENT `sheet.skills`, re-read on every call. Cards are properly signed
 * so `fetchAndVerifyCard` accepts the stranger card in the E2E test.
 */
function stubIdentity(target: Agent, sheet: SheetHolder): A2aIdentityProvider {
  return {
    async getIdentity(personalityId, audience) {
      if (personalityId !== target.id) {
        throw new EthosError({
          code: 'PERSONALITY_NOT_FOUND',
          cause: `Personality "${personalityId}" not found.`,
          action: 'unknown',
        });
      }
      const skills =
        audience === 'stranger' ? [] : sheet.skills.map((name) => ({ name, description: name }));
      const unsigned: Omit<AgentCard, 'signature'> = { ...target.unsigned, skills };
      return { ...unsigned, signature: signCard(unsigned, target.privateKeyPem) };
    },
  };
}

function stubSecrets(entries: Record<string, string>): SecretsResolver {
  const map = new Map(Object.entries(entries));
  return {
    async get(ref: SecretRef) {
      return map.get(ref) ?? null;
    },
    async set(ref: SecretRef, value: string) {
      map.set(ref, value);
    },
    async delete(ref: SecretRef) {
      map.delete(ref);
    },
    async list() {
      return [...map.keys()];
    },
  };
}

function stubAllowlist(approved: Map<string, PeerGrant>): A2aAllowlist {
  return {
    async lookup(_personalityId, peerFingerprint) {
      return approved.get(peerFingerprint) ?? null;
    },
  };
}

/** A runner that yields a fixed AgentEvent script and records that it was consumed. */
function stubRunner(script: AgentEvent[], spy?: { consumed: boolean }): A2aTaskRunner {
  return {
    async *run() {
      if (spy) spy.consumed = true;
      for (const e of script) yield e;
    },
  };
}

/** A runner that records the `opts` it was invoked with (plan T0.2). */
function capturingRunner(
  script: AgentEvent[],
  captured: { opts?: Parameters<A2aTaskRunner['run']>[2] },
): A2aTaskRunner {
  return {
    async *run(_personalityId, _text, opts) {
      captured.opts = opts;
      for (const e of script) yield e;
    },
  };
}

const HELLO_SCRIPT: AgentEvent[] = [
  { type: 'thinking_delta', thinking: 'secret internal reasoning' },
  { type: 'text_delta', text: 'hello ' },
  { type: 'text_delta', text: 'world' },
  { type: 'done', text: 'hello world', turnCount: 1 },
];

function signPop(peer: Agent, method: string, jti: string, timestamp: number): string {
  return signStruct({ context: 'a2a-request-pop', method, jti, timestamp }, peer.privateKeyPem);
}

const TARGET_ID = 'researcher';

async function mintPeerToken(
  target: Agent,
  peer: Agent,
  scope: string[],
  peerStore: StorageA2aPeerStore,
  opts: { enabled?: boolean; now?: number; ttlSeconds?: number } = {},
) {
  const minted = await mintToken(
    {
      peerAgentId: peer.id,
      peerFingerprint: peer.fingerprint,
      targetAgentId: TARGET_ID,
      scope,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}),
    },
    target.privateKeyPem,
  );
  await peerStore.upsert(TARGET_ID, {
    fingerprint: peer.fingerprint,
    card: peer.card,
    scope,
    tokenRef: minted.claims.jti,
    enabled: opts.enabled ?? true,
  });
  return minted;
}

interface Harness {
  target: Agent;
  peer: Agent;
  sheet: SheetHolder;
  peerStore: StorageA2aPeerStore;
  clock: { t: number };
  runnerSpy: { consumed: boolean };
  service: ReturnType<typeof createA2aRpcService>;
}

function makeHarness(sheetSkills: string[]): Harness {
  const target = makeAgent(TARGET_ID);
  const peer = makeAgent('peer-a');
  const sheet: SheetHolder = { skills: sheetSkills };
  const peerStore = new StorageA2aPeerStore(new InMemoryStorage(), '/ethos/a2a');
  const clock = { t: Date.now() };
  const runnerSpy = { consumed: false };
  const service = createA2aRpcService({
    getIdentity: stubIdentity(target, sheet),
    peerStore,
    runner: stubRunner(HELLO_SCRIPT, runnerSpy),
    now: () => clock.t,
  });
  return { target, peer, sheet, peerStore, clock, runnerSpy, service };
}

function rpcRequest(skill: string, message = 'hi') {
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    method: A2A_METHOD_MESSAGE_SEND,
    params: { skill, message },
  };
}

function asResult(res: JsonRpcResponse): A2aTaskResult {
  if ('error' in res)
    throw new Error(`expected result, got error ${res.error.code}: ${res.error.message}`);
  return res.result as A2aTaskResult;
}

// --- Happy path ------------------------------------------------------------

describe('A2A JSON-RPC message/send — happy path', () => {
  it('runs a scoped task with a valid token + PoP and returns the assistant result', async () => {
    const h = makeHarness(['search']);
    const minted = await mintPeerToken(h.target, h.peer, ['search'], h.peerStore, {
      now: h.clock.t,
    });
    const ts = h.clock.t;
    const creds: A2aRequestCredentials = {
      token: minted.token,
      proofSignature: signPop(h.peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, ts),
      proofTimestamp: ts,
    };

    const res = await h.service.handleRpc(TARGET_ID, rpcRequest('search'), creds);
    const result = asResult(res);
    expect(result.state).toBe('completed');
    expect(result.text).toBe('hello world');
    // The internal reasoning MUST NOT leak across the trust boundary.
    expect(result.text).not.toContain('secret internal reasoning');
    expect(h.runnerSpy.consumed).toBe(true);
  });

  it('threads params.skill through to the runner (plan T0.2) instead of discarding it', async () => {
    const target = makeAgent(TARGET_ID);
    const peer = makeAgent('peer-a');
    const sheet: SheetHolder = { skills: ['search'] };
    const peerStore = new StorageA2aPeerStore(new InMemoryStorage(), '/ethos/a2a');
    const clock = { t: Date.now() };
    const captured: { opts?: Parameters<A2aTaskRunner['run']>[2] } = {};
    const service = createA2aRpcService({
      getIdentity: stubIdentity(target, sheet),
      peerStore,
      runner: capturingRunner(HELLO_SCRIPT, captured),
      now: () => clock.t,
    });
    const minted = await mintPeerToken(target, peer, ['search'], peerStore, { now: clock.t });
    const creds: A2aRequestCredentials = {
      token: minted.token,
      proofSignature: signPop(peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, clock.t),
      proofTimestamp: clock.t,
    };

    await service.handleRpc(TARGET_ID, rpcRequest('search'), creds);
    expect(captured.opts?.skill).toBe('search');
  });
});

// --- Scope: outside the granted token scope --------------------------------

describe('Scope — skill outside the granted token scope', () => {
  it('rejects a skill that is in the sheet but not in the token scope', async () => {
    const h = makeHarness(['search', 'delete']); // sheet has both
    const minted = await mintPeerToken(h.target, h.peer, ['search'], h.peerStore, {
      now: h.clock.t,
    }); // token grants only search
    const ts = h.clock.t;
    const res = await h.service.handleRpc(TARGET_ID, rpcRequest('delete'), {
      token: minted.token,
      proofSignature: signPop(h.peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, ts),
      proofTimestamp: ts,
    });
    expect('error' in res && res.error.code).toBe(-32003);
    expect(h.runnerSpy.consumed).toBe(false);
  });
});

// --- Scope: outside the current character sheet ----------------------------

describe('Scope — skill outside the current character sheet', () => {
  it('rejects a skill that is in the token scope but not in the sheet', async () => {
    const h = makeHarness(['search']); // sheet has only search
    const minted = await mintPeerToken(h.target, h.peer, ['search', 'admin'], h.peerStore, {
      now: h.clock.t,
    }); // token grants admin too
    const ts = h.clock.t;
    const res = await h.service.handleRpc(TARGET_ID, rpcRequest('admin'), {
      token: minted.token,
      proofSignature: signPop(h.peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, ts),
      proofTimestamp: ts,
    });
    expect('error' in res && res.error.code).toBe(-32003);
  });
});

// --- Call-time revocation --------------------------------------------------

describe('Call-time revocation — removing a skill revokes an existing token', () => {
  it('the SAME valid token loses access the moment the skill leaves the sheet', async () => {
    const h = makeHarness(['search']);
    const minted = await mintPeerToken(h.target, h.peer, ['search'], h.peerStore, {
      now: h.clock.t,
    });
    const mkCreds = (ts: number): A2aRequestCredentials => ({
      token: minted.token,
      proofSignature: signPop(h.peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, ts),
      proofTimestamp: ts,
    });

    // First call succeeds while the skill is on the sheet.
    const ok = await h.service.handleRpc(TARGET_ID, rpcRequest('search'), mkCreds(h.clock.t));
    expect(asResult(ok).state).toBe('completed');

    // Owner removes the skill from the toolset/sheet — no re-grant, no new token.
    h.sheet.skills = [];

    // A fresh PoP (new timestamp — proofs are single-use) with the same token.
    h.clock.t += 1000;
    const denied = await h.service.handleRpc(TARGET_ID, rpcRequest('search'), mkCreds(h.clock.t));
    expect('error' in denied && denied.error.code).toBe(-32003);
  });
});

// --- Per-request proof-of-possession ---------------------------------------

describe('Per-request PoP — a stolen token without the peer key is inert', () => {
  it('rejects a valid token with NO proof', async () => {
    const h = makeHarness(['search']);
    const minted = await mintPeerToken(h.target, h.peer, ['search'], h.peerStore, {
      now: h.clock.t,
    });
    const res = await h.service.handleRpc(TARGET_ID, rpcRequest('search'), {
      token: minted.token,
      proofSignature: null,
      proofTimestamp: null,
    });
    expect('error' in res && res.error.code).toBe(-32002);
    expect(h.runnerSpy.consumed).toBe(false);
  });

  it('rejects a valid token with a proof signed by the WRONG key (stolen token)', async () => {
    const h = makeHarness(['search']);
    const minted = await mintPeerToken(h.target, h.peer, ['search'], h.peerStore, {
      now: h.clock.t,
    });
    const attacker = makeAgent('attacker'); // has the token, NOT the peer's key
    const ts = h.clock.t;
    const res = await h.service.handleRpc(TARGET_ID, rpcRequest('search'), {
      token: minted.token,
      proofSignature: signPop(attacker, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, ts),
      proofTimestamp: ts,
    });
    expect('error' in res && res.error.code).toBe(-32002);
    expect(h.runnerSpy.consumed).toBe(false);
  });

  it('rejects a proof over the wrong jti (proof minted for a different token)', async () => {
    const h = makeHarness(['search']);
    const minted = await mintPeerToken(h.target, h.peer, ['search'], h.peerStore, {
      now: h.clock.t,
    });
    const ts = h.clock.t;
    const res = await h.service.handleRpc(TARGET_ID, rpcRequest('search'), {
      token: minted.token,
      proofSignature: signPop(h.peer, A2A_METHOD_MESSAGE_SEND, 'some-other-jti', ts),
      proofTimestamp: ts,
    });
    expect('error' in res && res.error.code).toBe(-32002);
  });

  it('rejects a replayed proof (single-use within the window)', async () => {
    const h = makeHarness(['search']);
    const minted = await mintPeerToken(h.target, h.peer, ['search'], h.peerStore, {
      now: h.clock.t,
    });
    const ts = h.clock.t;
    const creds: A2aRequestCredentials = {
      token: minted.token,
      proofSignature: signPop(h.peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, ts),
      proofTimestamp: ts,
    };
    const first = await h.service.handleRpc(TARGET_ID, rpcRequest('search'), creds);
    expect(asResult(first).state).toBe('completed');
    const second = await h.service.handleRpc(TARGET_ID, rpcRequest('search'), creds);
    expect('error' in second && second.error.code).toBe(-32002);
  });

  it('rejects a proof whose timestamp is outside the window', async () => {
    const h = makeHarness(['search']);
    const minted = await mintPeerToken(h.target, h.peer, ['search'], h.peerStore, {
      now: h.clock.t,
    });
    const staleTs = h.clock.t - 120_000; // 2 min old, window is 60s
    const res = await h.service.handleRpc(TARGET_ID, rpcRequest('search'), {
      token: minted.token,
      proofSignature: signPop(h.peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, staleTs),
      proofTimestamp: staleTs,
    });
    expect('error' in res && res.error.code).toBe(-32002);
  });

  it('accepts a correct proof (the round-trip control)', async () => {
    const h = makeHarness(['search']);
    const minted = await mintPeerToken(h.target, h.peer, ['search'], h.peerStore, {
      now: h.clock.t,
    });
    const ts = h.clock.t;
    const res = await h.service.handleRpc(TARGET_ID, rpcRequest('search'), {
      token: minted.token,
      proofSignature: signPop(h.peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, ts),
      proofTimestamp: ts,
    });
    expect(asResult(res).state).toBe('completed');
  });
});

// --- Token expiry + disabled peer ------------------------------------------

describe('Token — expiry and disabled-peer revocation', () => {
  it('rejects an expired token', async () => {
    const h = makeHarness(['search']);
    const base = h.clock.t;
    const minted = await mintPeerToken(h.target, h.peer, ['search'], h.peerStore, {
      now: base,
      ttlSeconds: 3600,
    });
    h.clock.t = base + 2 * 3600 * 1000; // 2h later — past the 1h TTL
    const ts = h.clock.t;
    const res = await h.service.handleRpc(TARGET_ID, rpcRequest('search'), {
      token: minted.token,
      proofSignature: signPop(h.peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, ts),
      proofTimestamp: ts,
    });
    expect('error' in res && res.error.code).toBe(-32001);
  });

  it('rejects a token whose peer entry is disabled', async () => {
    const h = makeHarness(['search']);
    const minted = await mintPeerToken(h.target, h.peer, ['search'], h.peerStore, {
      now: h.clock.t,
      enabled: false, // peer disabled — revocation gate
    });
    const ts = h.clock.t;
    const res = await h.service.handleRpc(TARGET_ID, rpcRequest('search'), {
      token: minted.token,
      proofSignature: signPop(h.peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, ts),
      proofTimestamp: ts,
    });
    expect('error' in res && res.error.code).toBe(-32001);
  });
});

// --- Failure mapping -------------------------------------------------------

describe('Runner failure mapping', () => {
  it('maps an error event to a failed task state', async () => {
    const target = makeAgent(TARGET_ID);
    const peer = makeAgent('peer-a');
    const sheet: SheetHolder = { skills: ['search'] };
    const peerStore = new StorageA2aPeerStore(new InMemoryStorage(), '/ethos/a2a');
    const clock = { t: Date.now() };
    const service = createA2aRpcService({
      getIdentity: stubIdentity(target, sheet),
      peerStore,
      runner: stubRunner([{ type: 'error', error: 'boom', code: 'INTERNAL' }]),
      now: () => clock.t,
    });
    const minted = await mintPeerToken(target, peer, ['search'], peerStore, { now: clock.t });
    const ts = clock.t;
    const res = await service.handleRpc(TARGET_ID, rpcRequest('search'), {
      token: minted.token,
      proofSignature: signPop(peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, ts),
      proofTimestamp: ts,
    });
    const result = asResult(res);
    expect(result.state).toBe('failed');
    expect(result.error).toBe('boom');
  });
});

// --- Method + shape guards -------------------------------------------------

describe('JSON-RPC envelope guards', () => {
  it('rejects an unknown method', async () => {
    const h = makeHarness(['search']);
    const res = await h.service.handleRpc(
      TARGET_ID,
      { jsonrpc: '2.0', id: 1, method: 'tasks/cancel', params: {} },
      { token: 't', proofSignature: null, proofTimestamp: null },
    );
    expect('error' in res && res.error.code).toBe(-32601);
  });

  it('rejects a non-JSON-RPC body', async () => {
    const h = makeHarness(['search']);
    const res = await h.service.handleRpc(
      TARGET_ID,
      { hello: 'world' },
      {
        token: 't',
        proofSignature: null,
        proofTimestamp: null,
      },
    );
    expect('error' in res && res.error.code).toBe(-32600);
  });
});

// --- End-to-end HTTP round-trip --------------------------------------------

describe('End-to-end — card → handshake → token → message/send over HTTP', () => {
  it('fetches the card, completes the Phase-4 handshake, then runs a scoped task with a PoP', async () => {
    const target = makeAgent(TARGET_ID);
    const peer = makeAgent('peer-a');
    const sheet: SheetHolder = { skills: ['search'] };
    const storage = new InMemoryStorage();
    const peerStore = new StorageA2aPeerStore(storage, '/ethos/a2a');
    const nonces = new MemoryNonceStore();
    const identity = stubIdentity(target, sheet);
    const runnerSpy = { consumed: false };

    const app = new Hono();
    // Mirror the Phase-2 RouteModule seam: three public modules, own auth each.
    app.route('/', createA2aWellKnownRouter({ getIdentity: identity }));
    app.route(
      '/a2a-auth',
      createA2aAuthRouter({
        secrets: stubSecrets({ [`a2a/${TARGET_ID}/private-key`]: target.privateKeyPem }),
        allowlist: stubAllowlist(
          new Map([
            [peer.fingerprint, { fingerprint: peer.fingerprint, scope: ['search'], enabled: true }],
          ]),
        ),
        peerStore,
        nonces,
      }),
    );
    app.route(
      '/a2a',
      createA2aRpcRouter({
        getIdentity: identity,
        peerStore,
        runner: stubRunner(HELLO_SCRIPT, runnerSpy),
      }),
    );

    // 1. Fetch + verify the public (stranger) card via the client.
    const card = await fetchAndVerifyCard(
      `http://x/.well-known/agent-card.json?personality=${TARGET_ID}`,
      {
        expectedFingerprint: target.fingerprint,
        fetchImpl: ((input: string | URL) =>
          app.request(
            typeof input === 'string' ? input.replace('http://x', '') : input,
          )) as typeof fetch,
      },
    );
    expect(card.id).toBe(TARGET_ID);
    expect(card.skills).toEqual([]); // stranger tier leaks no skills

    // 2. Handshake — challenge.
    const chRes = await app.request(`/a2a-auth/${TARGET_ID}/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ card: peer.card }),
    });
    expect(chRes.status).toBe(200);
    const ch = (await chRes.json()) as { nonce: string };

    // 3. Handshake — response (domain-separated signature over the nonce).
    const authTs = Date.now();
    const respRes = await app.request(`/a2a-auth/${TARGET_ID}/response`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nonce: ch.nonce,
        timestamp: authTs,
        signature: signStruct(
          {
            context: 'a2a-auth-challenge',
            nonce: ch.nonce,
            target_agent_id: TARGET_ID,
            timestamp: authTs,
          },
          peer.privateKeyPem,
        ),
        fingerprint: peer.fingerprint,
      }),
    });
    expect(respRes.status).toBe(200);
    const { token } = (await respRes.json()) as { token: string };

    // 4. message/send with the token + a per-request PoP.
    const jti = decodeJwt(token).jti;
    if (typeof jti !== 'string') throw new Error('token has no jti');
    const popTs = Date.now();
    const sendRes = await app.request(`/a2a/${TARGET_ID}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-a2a-pop': signPop(peer, A2A_METHOD_MESSAGE_SEND, jti, popTs),
        'x-a2a-pop-timestamp': String(popTs),
      },
      body: JSON.stringify(rpcRequest('search', 'find me a paper')),
    });
    expect(sendRes.status).toBe(200);
    const body = (await sendRes.json()) as JsonRpcResponse;
    const result = asResult(body);
    expect(result.state).toBe('completed');
    expect(result.text).toBe('hello world');
    expect(runnerSpy.consumed).toBe(true);

    // 5. A stranger's stolen token replay without the peer key is inert: reuse
    //    the same PoP → single-use rejection proves replay protection end-to-end.
    const replay = await app.request(`/a2a/${TARGET_ID}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-a2a-pop': signPop(peer, A2A_METHOD_MESSAGE_SEND, jti, popTs),
        'x-a2a-pop-timestamp': String(popTs),
      },
      body: JSON.stringify(rpcRequest('search', 'again')),
    });
    const replayBody = (await replay.json()) as JsonRpcResponse;
    expect('error' in replayBody && replayBody.error.code).toBe(-32002);
  });
});
