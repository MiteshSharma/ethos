// T1.8 real-socket integration harness.
//
// Every OTHER A2A test drives Hono in-process via `app.request()` against a
// stubbed transport — the client's `fetchImpl` dispatches straight into the
// app object, no socket involved. That is a strong suite for LOGIC, but it
// proves nothing about the WIRE: header casing over a real socket, chunked SSE
// framing, timeout behaviour against a genuinely half-open connection, or two
// separate server instances sharing nothing but HTTP.
//
// This harness boots a REAL Ethos A2A server (well-known + auth + rpc routers)
// on a real ephemeral port via `@hono/node-server`, so the integration tests
// in this directory exercise the actual TCP/HTTP path.
//
// Deliberately separate from `../a2a-fixtures.ts`: that file's `makeAgent()`
// bakes a fixed placeholder port (8787) into the card, which is harmless for
// `app.request()` tests (the stub ignores host:port and dispatches on path)
// but wrong here — a real `fetch()` needs the card to advertise the ACTUAL
// bound port. The card is therefore built lazily via a closure over a
// `portRef` cell that is filled in only once `honoServe`'s listening callback
// fires; nobody calls `getIdentity()` before an HTTP request arrives, by which
// point the server is definitely listening.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { A2aIdentityProvider, AgentCard, SecretsResolver } from '@ethosagent/types';
import { EthosError } from '@ethosagent/types';
import { serve as honoServe, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { createA2aAuthRouter } from '../../auth';
import { buildDidDocument, fingerprint, generateEd25519, signCard } from '../../crypto';
import { type A2aTaskRunner, createA2aRpcRouter } from '../../rpc';
import { MemoryNonceStore, StorageA2aAllowlist, StorageA2aPeerStore } from '../../stores';
import { InMemoryA2aTaskStore } from '../../task-store';
import { createA2aWellKnownRouter } from '../../well-known';

export interface RealAgentServer {
  id: string;
  port: number;
  baseUrl: string;
  wellKnownUrl: string;
  privateKeyPem: string;
  fingerprint: string;
  /** This agent's own full-skill card — what `connect()`'s `myCard` presents. */
  card: AgentCard;
  peerStore: StorageA2aPeerStore;
  allowlist: StorageA2aAllowlist;
  taskStore: InMemoryA2aTaskStore;
  close(): Promise<void>;
}

export interface StartAgentServerOptions {
  id: string;
  skills: string[];
  runner: A2aTaskRunner;
}

/** A runner that echoes the inbound text with a prefix — deterministic, fast. */
export function echoRunner(prefix: string): A2aTaskRunner {
  return {
    async *run(_personalityId, text) {
      const out = `${prefix}${text}`;
      yield { type: 'text_delta', text: out };
      yield { type: 'done', text: out, turnCount: 1 };
    },
  };
}

/** Boot one real Ethos A2A server on an ephemeral loopback port. */
export async function startAgentServer(opts: StartAgentServerOptions): Promise<RealAgentServer> {
  const { privateKeyPem, rawPublicKey } = generateEd25519();
  const fp = fingerprint(rawPublicKey);
  const portRef = { current: 0 };

  const buildCard = (skills: string[]): AgentCard => {
    const base = `http://127.0.0.1:${portRef.current}`;
    const jsonRpc = `${base}/a2a/${opts.id}`;
    const unsigned: Omit<AgentCard, 'signature'> = {
      id: opts.id,
      name: opts.id,
      description: `Real-socket integration test agent "${opts.id}".`,
      protocolVersion: 'a2a/0.1',
      skills: skills.map((name) => ({ name, description: name })),
      endpoints: { jsonRpc, auth: `${base}/a2a-auth/${opts.id}` },
      publicKey: rawPublicKey.toString('base64'),
      keyFingerprint: fp,
      signatureAlg: 'ed25519',
      did: buildDidDocument(rawPublicKey, jsonRpc),
    };
    return { ...unsigned, signature: signCard(unsigned, privateKeyPem) };
  };

  const getIdentity: A2aIdentityProvider = {
    async getIdentity(personalityId, audience) {
      if (personalityId !== opts.id) {
        throw new EthosError({
          code: 'PERSONALITY_NOT_FOUND',
          cause: `Personality "${personalityId}" not found.`,
          action: 'unknown',
        });
      }
      return buildCard(audience === 'stranger' ? [] : opts.skills);
    },
  };

  const privateKeyRefKey = `a2a/${opts.id}/private-key`;
  const secrets: SecretsResolver = {
    async get(ref) {
      return ref === privateKeyRefKey ? privateKeyPem : null;
    },
    async set() {},
    async delete() {},
    async list() {
      return [];
    },
  };

  const peerStore = new StorageA2aPeerStore(new InMemoryStorage(), '/ethos/a2a');
  const allowlist = new StorageA2aAllowlist(new InMemoryStorage(), '/ethos/a2a');
  const taskStore = new InMemoryA2aTaskStore();

  const app = new Hono();
  app.route('/', createA2aWellKnownRouter({ getIdentity }));
  app.route(
    '/a2a-auth',
    createA2aAuthRouter({ secrets, allowlist, peerStore, nonces: new MemoryNonceStore() }),
  );
  app.route('/a2a', createA2aRpcRouter({ getIdentity, peerStore, runner: opts.runner, taskStore }));

  const server = await new Promise<ServerType>((resolve, reject) => {
    const s = honoServe({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      portRef.current = info.port;
      resolve(s);
    });
    s.once('error', reject);
  });

  const baseUrl = `http://127.0.0.1:${portRef.current}`;
  return {
    id: opts.id,
    port: portRef.current,
    baseUrl,
    wellKnownUrl: `${baseUrl}/.well-known/agent-card.json?personality=${opts.id}`,
    privateKeyPem,
    fingerprint: fp,
    card: buildCard(opts.skills),
    peerStore,
    allowlist,
    taskStore,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Approve `peer` on `server`'s allowlist for `scope` (human-anchor step, real Storage write). */
export async function approvePeer(
  server: RealAgentServer,
  peerFingerprint: string,
  scope: string[],
): Promise<void> {
  await server.allowlist.upsert(server.id, { fingerprint: peerFingerprint, scope, enabled: true });
}

/**
 * Revoke `peerFingerprint` on `server` (plan §11 revocation lever a — same
 * mechanism `revocation.test.ts` proves at the unit level): flip the PEER
 * STORE entry's `enabled` flag. A live, unexpired token stops authenticating
 * on the very next request because `authenticate()`'s revocation gate re-reads
 * the peer store, not the allowlist, on every call.
 */
export async function revokePeer(server: RealAgentServer, peerFingerprint: string): Promise<void> {
  const entry = await server.peerStore.get(server.id, peerFingerprint);
  if (!entry) throw new Error(`revokePeer: no peer entry for ${peerFingerprint} on ${server.id}`);
  await server.peerStore.upsert(server.id, { ...entry, enabled: false });
}
