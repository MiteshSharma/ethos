// Phase 7 exposure gate — `a2a_send` driven against a REAL in-process A2A server
// (the same auth + rpc + well-known routers the inbound phases ship). No network:
// the injected client's `fetchImpl` dispatches into a Hono app via `app.request`.
//
// Covered:
//   (a) full round-trip — the tool resolves MY identity + key, connects, and
//       returns the peer's echoed text.
//   (b) delegation wiring — ctx.a2aDelegation → client → guard end to end: the
//       first onward call reserves the fan-out budget and the server admits the
//       depth-1 envelope; the second call exhausts the budget and returns the
//       fan-out tool error with NO onward HTTP call.

import {
  type A2aAllowlist,
  A2aDelegationGuard,
  A2aOutboundClient,
  type A2aTaskRunner,
  buildDelegationCredentials,
  createA2aAuthRouter,
  createA2aRpcRouter,
  createA2aWellKnownRouter,
  MemoryNonceStore,
  type PeerGrant,
  StorageA2aPeerStore,
} from '@ethosagent/a2a';
import {
  buildDidDocument,
  fingerprint,
  generateEd25519,
  rawPublicKeyFromPem,
  signCard,
} from '@ethosagent/a2a/crypto';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  A2aIdentityProvider,
  AgentCard,
  AgentEvent,
  SecretRef,
  SecretsResolver,
  ToolContext,
} from '@ethosagent/types';
import { EthosError } from '@ethosagent/types';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createA2aTools } from '../index';

// ---------------------------------------------------------------------------
// Fixtures — adapted from packages/a2a/src/__tests__/a2a-fixtures.ts (kept local
// so this extension does not reach into another package's private test dir).
// ---------------------------------------------------------------------------

interface Agent {
  id: string;
  privateKeyPem: string;
  rawPublicKey: Buffer;
  fingerprint: string;
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

function stubIdentity(agent: Agent, skills: string[]): A2aIdentityProvider {
  return {
    async getIdentity(personalityId, audience) {
      if (personalityId !== agent.id) {
        throw new EthosError({
          code: 'PERSONALITY_NOT_FOUND',
          cause: `Personality "${personalityId}" not found.`,
          action: 'unknown',
        });
      }
      const visible =
        audience === 'stranger' ? [] : skills.map((name) => ({ name, description: name }));
      const unsigned: Omit<AgentCard, 'signature'> = { ...agent.unsigned, skills: visible };
      return { ...unsigned, signature: signCard(unsigned, agent.privateKeyPem) };
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

/** An egress allowlist approving each given agent's fingerprint (default-deny otherwise). */
function egressAllow(...agents: Agent[]): A2aAllowlist {
  return stubAllowlist(
    new Map(
      agents.map((a) => [a.fingerprint, { fingerprint: a.fingerprint, scope: [], enabled: true }]),
    ),
  );
}

const HELLO_SCRIPT: AgentEvent[] = [
  { type: 'text_delta', text: 'hello ' },
  { type: 'text_delta', text: 'world' },
  { type: 'done', text: 'hello world', turnCount: 1 },
];

function countingRunner(script: AgentEvent[], counter: { runs: number }): A2aTaskRunner {
  return {
    async *run() {
      counter.runs += 1;
      for (const e of script) yield e;
    },
  };
}

function newPeerStore(): StorageA2aPeerStore {
  return new StorageA2aPeerStore(new InMemoryStorage(), '/ethos/a2a');
}

function toUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Real target server: well-known + auth + rpc sharing one peer store. */
function makeServer(
  target: Agent,
  initiator: Agent,
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
      getIdentity: stubIdentity(target, ['search']),
      peerStore,
      runner: countingRunner(HELLO_SCRIPT, counter),
      now: () => clock.t,
      ...(opts.rpcGuard ? { delegationGuard: opts.rpcGuard } : {}),
    }),
  );
  app.route('/', createA2aWellKnownRouter({ getIdentity: stubIdentity(target, ['search']) }));

  return { app, counter };
}

const TARGET_ID = 'researcher';
const WELL_KNOWN_URL = `http://localhost:8787/.well-known/agent-card.json?personality=${TARGET_ID}`;

function makeCtx(personalityId: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 's1',
    sessionKey: 'cli:default',
    platform: 'cli',
    workingDir: '/tmp',
    personalityId,
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 20_000,
    ...overrides,
  };
}

describe('a2a_send — full round-trip', () => {
  it('resolves my identity + key, connects, and returns the peer text', async () => {
    const target = makeAgent(TARGET_ID);
    const initiator = makeAgent('me');
    const clock = { t: Date.now() };
    const { app, counter } = makeServer(target, initiator, clock);

    const fetchImpl: typeof fetch = async (input, init) => app.request(toUrl(input), init);
    const client = new A2aOutboundClient({ fetchImpl, now: () => clock.t });

    const [tool] = createA2aTools({
      identity: stubIdentity(initiator, ['search']),
      secrets: stubSecrets({ [`a2a/${initiator.id}/private-key`]: initiator.privateKeyPem }),
      allowlist: egressAllow(target),
      client,
    });

    const result = await tool?.execute(
      {
        peer_url: WELL_KNOWN_URL,
        fingerprint: target.fingerprint,
        skill: 'search',
        message: 'hi',
      },
      makeCtx(initiator.id),
    );

    expect(result?.ok).toBe(true);
    if (result?.ok) expect(result.value).toBe('hello world');
    expect(counter.runs).toBe(1);
  });

  it('returns input_invalid when no active personality is set', async () => {
    const initiator = makeAgent('me');
    const [tool] = createA2aTools({
      identity: stubIdentity(initiator, ['search']),
      secrets: stubSecrets({ [`a2a/${initiator.id}/private-key`]: initiator.privateKeyPem }),
      allowlist: egressAllow(),
      client: new A2aOutboundClient(),
    });
    const result = await tool?.execute(
      { peer_url: WELL_KNOWN_URL, skill: 'search', message: 'hi' },
      makeCtx(''),
    );
    expect(result?.ok).toBe(false);
    if (result && !result.ok) expect(result.code).toBe('input_invalid');
  });

  it('returns not_available when the signing key is missing', async () => {
    const initiator = makeAgent('me');
    const [tool] = createA2aTools({
      identity: stubIdentity(initiator, ['search']),
      secrets: stubSecrets({}),
      allowlist: egressAllow(),
      client: new A2aOutboundClient(),
    });
    const result = await tool?.execute(
      { peer_url: WELL_KNOWN_URL, skill: 'search', message: 'hi' },
      makeCtx(initiator.id),
    );
    expect(result?.ok).toBe(false);
    if (result && !result.ok) expect(result.code).toBe('not_available');
  });
});

describe('a2a_send — session/token caching (plan T1.2)', () => {
  it('performs exactly ONE handshake across two sequential sends to the same peer', async () => {
    const target = makeAgent(TARGET_ID);
    const initiator = makeAgent('me');
    const clock = { t: Date.now() };
    const { app, counter } = makeServer(target, initiator, clock);

    let authPosts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = toUrl(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/a2a-auth/')) authPosts += 1;
      return app.request(url, init);
    };
    const client = new A2aOutboundClient({ fetchImpl, now: () => clock.t });

    const [tool] = createA2aTools({
      identity: stubIdentity(initiator, ['search']),
      secrets: stubSecrets({ [`a2a/${initiator.id}/private-key`]: initiator.privateKeyPem }),
      allowlist: egressAllow(target),
      client,
    });
    const args = {
      peer_url: WELL_KNOWN_URL,
      fingerprint: target.fingerprint,
      skill: 'search',
      message: 'hi',
    };

    const first = await tool?.execute(args, makeCtx(initiator.id));
    const second = await tool?.execute(args, makeCtx(initiator.id));

    expect(first?.ok).toBe(true);
    expect(second?.ok).toBe(true);
    expect(counter.runs).toBe(2);
    // The handshake is challenge + response = 2 POSTs to /a2a-auth/ — ONCE
    // total across both sends, not once PER send.
    expect(authPosts).toBe(2);
  });

  it('hits the cache via peer_url even when the repeat call omits the fingerprint arg', async () => {
    const target = makeAgent(TARGET_ID);
    const initiator = makeAgent('me');
    const clock = { t: Date.now() };
    const { app, counter } = makeServer(target, initiator, clock);

    let authPosts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = toUrl(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/a2a-auth/')) authPosts += 1;
      return app.request(url, init);
    };
    const client = new A2aOutboundClient({ fetchImpl, now: () => clock.t });

    const [tool] = createA2aTools({
      identity: stubIdentity(initiator, ['search']),
      secrets: stubSecrets({ [`a2a/${initiator.id}/private-key`]: initiator.privateKeyPem }),
      allowlist: egressAllow(target),
      client,
    });

    const first = await tool?.execute(
      { peer_url: WELL_KNOWN_URL, fingerprint: target.fingerprint, skill: 'search', message: 'hi' },
      makeCtx(initiator.id),
    );
    // Second call omits `fingerprint` — the url index must still find it.
    const second = await tool?.execute(
      { peer_url: WELL_KNOWN_URL, skill: 'search', message: 'hi again' },
      makeCtx(initiator.id),
    );

    expect(first?.ok).toBe(true);
    expect(second?.ok).toBe(true);
    expect(counter.runs).toBe(2);
    expect(authPosts).toBe(2);
  });

  it('a revoked peer fails closed on the very next send — no stale cached token grants access', async () => {
    const target = makeAgent(TARGET_ID);
    const initiator = makeAgent('me');
    const clock = { t: Date.now() };
    const { app, counter } = makeServer(target, initiator, clock);
    const fetchImpl: typeof fetch = async (input, init) => app.request(toUrl(input), init);
    const client = new A2aOutboundClient({ fetchImpl, now: () => clock.t });

    // A MUTABLE egress allowlist so the test can simulate revocation between
    // the two calls (distinct from the target's own INBOUND allowlist).
    const myEgress = new Map([
      [target.fingerprint, { fingerprint: target.fingerprint, scope: [], enabled: true }],
    ]);
    const [tool] = createA2aTools({
      identity: stubIdentity(initiator, ['search']),
      secrets: stubSecrets({ [`a2a/${initiator.id}/private-key`]: initiator.privateKeyPem }),
      allowlist: stubAllowlist(myEgress),
      client,
    });
    const args = {
      peer_url: WELL_KNOWN_URL,
      fingerprint: target.fingerprint,
      skill: 'search',
      message: 'hi',
    };

    const first = await tool?.execute(args, makeCtx(initiator.id));
    expect(first?.ok).toBe(true);
    expect(counter.runs).toBe(1);

    // Revoke: remove the peer from MY OWN egress allowlist. No cache-change
    // notification exists (D13) — the cached token is still cryptographically
    // valid; only the per-send allowlist re-check catches this.
    myEgress.delete(target.fingerprint);

    const second = await tool?.execute(args, makeCtx(initiator.id));
    expect(second?.ok).toBe(false);
    if (second && !second.ok) {
      expect(second.code).toBe('execution_failed');
      expect(second.error).toContain('egress allowlist');
    }
    // The stale cached token granted NO access — no second delivery happened.
    expect(counter.runs).toBe(1);
  });

  it('invalidates the cache on an auth-rejection from the peer, so the next send re-handshakes', async () => {
    const target = makeAgent(TARGET_ID);
    const initiator = makeAgent('me');
    const clock = { t: Date.now() };
    const { app, counter } = makeServer(target, initiator, clock);

    let authPosts = 0;
    let rpcCalls = 0;
    // The first RPC call gets a normal response; from the second RPC call
    // onward (simulating the peer having revoked/rotated our token server
    // side) we substitute a synthetic UNAUTHORIZED JSON-RPC error, mirroring
    // what a real peer would send back on a bad token.
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = toUrl(input);
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url.includes('/a2a-auth/')) authPosts += 1;
      if (method === 'POST' && url.includes('/a2a/') && !url.includes('/a2a-auth/')) {
        rpcCalls += 1;
        if (rpcCalls === 2) {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'x',
              error: { code: -32001, message: 'token rejected: revoked' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
      }
      return app.request(url, init);
    };
    const client = new A2aOutboundClient({ fetchImpl, now: () => clock.t });

    const [tool] = createA2aTools({
      identity: stubIdentity(initiator, ['search']),
      secrets: stubSecrets({ [`a2a/${initiator.id}/private-key`]: initiator.privateKeyPem }),
      allowlist: egressAllow(target),
      client,
    });
    const args = {
      peer_url: WELL_KNOWN_URL,
      fingerprint: target.fingerprint,
      skill: 'search',
      message: 'hi',
    };

    const first = await tool?.execute(args, makeCtx(initiator.id));
    expect(first?.ok).toBe(true);

    // Second send: cache hit skips the handshake, the synthetic peer rejection
    // fires, and the cache MUST be invalidated (not just surfaced as an error).
    const second = await tool?.execute(args, makeCtx(initiator.id));
    expect(second?.ok).toBe(false);
    expect(authPosts).toBe(2); // still just the ONE real handshake so far

    // Third send: the invalidated cache forces a fresh handshake, which
    // succeeds again (the real server never actually revoked anything).
    const third = await tool?.execute(args, makeCtx(initiator.id));
    expect(third?.ok).toBe(true);
    expect(authPosts).toBe(4); // a SECOND handshake happened
    expect(counter.runs).toBe(2); // first + third delivered; second did not
  });
});

describe('a2a_send — delegation containment (ctx.a2aDelegation → client → guard)', () => {
  it('first call fans out under budget; second call is refused with no onward HTTP', async () => {
    const target = makeAgent(TARGET_ID);
    const initiator = makeAgent('me');
    const clock = { t: Date.now() };
    // Server-side guard admits the depth-1 envelope the tool's client signs.
    const { app, counter } = makeServer(target, initiator, clock, {
      rpcGuard: new A2aDelegationGuard(),
    });

    // This agent's process guard: exactly one onward call per trace.
    const guard = new A2aDelegationGuard({ fanOutBudget: 1 });
    const traceId = 't1';
    // Open the trace ref-count as an inbound admission would (depth 0, signed).
    const caller = generateEd25519();
    const admission = guard.admitInbound(
      buildDelegationCredentials(traceId, 0, caller.privateKeyPem),
      rawPublicKeyFromPem(caller.privateKeyPem),
    );
    expect(admission.ok).toBe(true);

    let rpcPosts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = toUrl(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/a2a/')) rpcPosts += 1;
      return app.request(url, init);
    };
    const client = new A2aOutboundClient({ fetchImpl, now: () => clock.t });

    const [tool] = createA2aTools({
      identity: stubIdentity(initiator, ['search']),
      secrets: stubSecrets({ [`a2a/${initiator.id}/private-key`]: initiator.privateKeyPem }),
      allowlist: egressAllow(target),
      client,
    });

    const ctx = makeCtx(initiator.id, {
      a2aDelegation: { traceId, depth: 0, reserveOutbound: () => guard.reserveOutbound(traceId) },
    });
    const args = {
      peer_url: WELL_KNOWN_URL,
      fingerprint: target.fingerprint,
      skill: 'search',
      message: 'hi',
    };

    const first = await tool?.execute(args, ctx);
    expect(first?.ok).toBe(true);
    if (first?.ok) expect(first.value).toBe('hello world');
    expect(counter.runs).toBe(1);
    expect(rpcPosts).toBe(1);

    const second = await tool?.execute(args, ctx);
    expect(second?.ok).toBe(false);
    if (second && !second.ok) {
      expect(second.code).toBe('execution_failed');
      expect(second.error).toContain('fan-out budget exhausted');
    }
    // No second onward HTTP call, no second runner invocation.
    expect(rpcPosts).toBe(1);
    expect(counter.runs).toBe(1);
  });
});

describe('a2a_send — self-loop guard (plan §14)', () => {
  it('refuses to call my own agent by default (maps to a clear tool error)', async () => {
    const me = makeAgent(TARGET_ID);
    const clock = { t: Date.now() };
    const { app, counter } = makeServer(me, me, clock);
    const fetchImpl: typeof fetch = async (input, init) => app.request(toUrl(input), init);
    const client = new A2aOutboundClient({ fetchImpl, now: () => clock.t });

    const [tool] = createA2aTools({
      identity: stubIdentity(me, ['search']),
      secrets: stubSecrets({ [`a2a/${me.id}/private-key`]: me.privateKeyPem }),
      allowlist: egressAllow(me),
      client,
    });

    const result = await tool?.execute(
      { peer_url: WELL_KNOWN_URL, fingerprint: me.fingerprint, skill: 'search', message: 'hi' },
      makeCtx(me.id),
    );
    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toContain('self-loop is disabled');
    }
    expect(counter.runs).toBe(0);
  });

  it('allows the self-loop when deps.allowSelfLoop is set', async () => {
    const me = makeAgent(TARGET_ID);
    const clock = { t: Date.now() };
    const { app, counter } = makeServer(me, me, clock);
    const fetchImpl: typeof fetch = async (input, init) => app.request(toUrl(input), init);
    const client = new A2aOutboundClient({ fetchImpl, now: () => clock.t });

    const [tool] = createA2aTools({
      identity: stubIdentity(me, ['search']),
      secrets: stubSecrets({ [`a2a/${me.id}/private-key`]: me.privateKeyPem }),
      allowlist: egressAllow(me),
      client,
      allowSelfLoop: true,
    });

    const result = await tool?.execute(
      { peer_url: WELL_KNOWN_URL, fingerprint: me.fingerprint, skill: 'search', message: 'hi me' },
      makeCtx(me.id),
    );
    expect(result?.ok).toBe(true);
    if (result?.ok) expect(result.value).toBe('hello world');
    expect(counter.runs).toBe(1);
  });
});

describe('a2a_send — live enablement gate (Stage 1c)', () => {
  it('returns not_available without touching identity/secrets/network when isEnabled is false', async () => {
    let identityCalls = 0;
    let secretCalls = 0;
    let fetchCalls = 0;
    const initiator = makeAgent('me');

    const identity: A2aIdentityProvider = {
      async getIdentity(personalityId, audience) {
        identityCalls += 1;
        return stubIdentity(initiator, ['search']).getIdentity(personalityId, audience);
      },
    };
    const secrets: SecretsResolver = {
      async get(_ref: SecretRef) {
        secretCalls += 1;
        return initiator.privateKeyPem;
      },
      async set() {},
      async delete() {},
      async list() {
        return [];
      },
    };
    const fetchImpl: typeof fetch = async () => {
      fetchCalls += 1;
      return new Response('{}');
    };

    const [tool] = createA2aTools({
      identity,
      secrets,
      allowlist: egressAllow(),
      client: new A2aOutboundClient({ fetchImpl }),
      isEnabled: () => false,
    });

    const result = await tool?.execute(
      { peer_url: WELL_KNOWN_URL, skill: 'search', message: 'hi' },
      makeCtx(initiator.id),
    );

    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.code).toBe('not_available');
      expect(result.error).toContain('A2A is disabled');
    }
    // The gate short-circuits before any identity/secret/network work.
    expect(identityCalls).toBe(0);
    expect(secretCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  it('proceeds end to end when isEnabled returns true', async () => {
    const target = makeAgent(TARGET_ID);
    const initiator = makeAgent('me');
    const clock = { t: Date.now() };
    const { app, counter } = makeServer(target, initiator, clock);
    const fetchImpl: typeof fetch = async (input, init) => app.request(toUrl(input), init);
    const client = new A2aOutboundClient({ fetchImpl, now: () => clock.t });

    const [tool] = createA2aTools({
      identity: stubIdentity(initiator, ['search']),
      secrets: stubSecrets({ [`a2a/${initiator.id}/private-key`]: initiator.privateKeyPem }),
      allowlist: egressAllow(target),
      client,
      isEnabled: () => true,
    });

    const result = await tool?.execute(
      { peer_url: WELL_KNOWN_URL, fingerprint: target.fingerprint, skill: 'search', message: 'hi' },
      makeCtx(initiator.id),
    );

    expect(result?.ok).toBe(true);
    if (result?.ok) expect(result.value).toBe('hello world');
    expect(counter.runs).toBe(1);
  });
});

describe('a2a_send — egress default-deny (plan §15)', () => {
  it('refuses a non-allowlisted peer BEFORE any handshake (no challenge POST)', async () => {
    const target = makeAgent(TARGET_ID);
    const initiator = makeAgent('me');
    const clock = { t: Date.now() };
    const { app, counter } = makeServer(target, initiator, clock);

    // Count challenge POSTs to the auth endpoint — the first handshake step.
    let authPosts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = toUrl(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/a2a-auth/')) authPosts += 1;
      return app.request(url, init);
    };
    const client = new A2aOutboundClient({ fetchImpl, now: () => clock.t });

    // Egress allowlist is EMPTY — the target is not approved for this personality.
    const [tool] = createA2aTools({
      identity: stubIdentity(initiator, ['search']),
      secrets: stubSecrets({ [`a2a/${initiator.id}/private-key`]: initiator.privateKeyPem }),
      allowlist: egressAllow(),
      client,
    });

    const result = await tool?.execute(
      {
        peer_url: WELL_KNOWN_URL,
        fingerprint: target.fingerprint,
        skill: 'search',
        message: 'hi',
      },
      makeCtx(initiator.id),
    );

    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toContain('egress allowlist');
    }
    // No handshake was attempted, no run happened.
    expect(authPosts).toBe(0);
    expect(counter.runs).toBe(0);
  });

  it('lets an allowlisted peer through end to end', async () => {
    const target = makeAgent(TARGET_ID);
    const initiator = makeAgent('me');
    const clock = { t: Date.now() };
    const { app, counter } = makeServer(target, initiator, clock);
    const fetchImpl: typeof fetch = async (input, init) => app.request(toUrl(input), init);
    const client = new A2aOutboundClient({ fetchImpl, now: () => clock.t });

    const [tool] = createA2aTools({
      identity: stubIdentity(initiator, ['search']),
      secrets: stubSecrets({ [`a2a/${initiator.id}/private-key`]: initiator.privateKeyPem }),
      allowlist: egressAllow(target),
      client,
    });

    const result = await tool?.execute(
      {
        peer_url: WELL_KNOWN_URL,
        fingerprint: target.fingerprint,
        skill: 'search',
        message: 'hi',
      },
      makeCtx(initiator.id),
    );

    expect(result?.ok).toBe(true);
    if (result?.ok) expect(result.value).toBe('hello world');
    expect(counter.runs).toBe(1);
  });
});
