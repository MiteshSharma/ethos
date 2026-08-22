// Shared test fixtures for the Phase-6 async + delegation suites. Mirrors the
// inline helpers in rpc.test.ts (kept separate so the Phase-5 file stays frozen).

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  A2aIdentityProvider,
  AgentCard,
  AgentEvent,
  SecretRef,
  SecretsResolver,
} from '@ethosagent/types';
import { EthosError } from '@ethosagent/types';
import { buildDidDocument, fingerprint, generateEd25519, signCard, signStruct } from '../crypto';
import { A2A_METHOD_MESSAGE_SEND, type A2aTaskRunner } from '../rpc';
import { type A2aAllowlist, type PeerGrant, StorageA2aPeerStore } from '../stores';
import { mintToken } from '../tokens';

export interface Agent {
  id: string;
  privateKeyPem: string;
  rawPublicKey: Buffer;
  fingerprint: string;
  unsigned: Omit<AgentCard, 'signature'>;
  card: AgentCard;
}

export function makeAgent(id: string): Agent {
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

export interface SheetHolder {
  skills: string[];
}

export function stubIdentity(target: Agent, sheet: SheetHolder): A2aIdentityProvider {
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

export function stubSecrets(entries: Record<string, string>): SecretsResolver {
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

export function stubAllowlist(approved: Map<string, PeerGrant>): A2aAllowlist {
  return {
    async lookup(_personalityId, peerFingerprint) {
      return approved.get(peerFingerprint) ?? null;
    },
  };
}

/** A runner that yields a fixed script and counts how many times it was invoked. */
export function countingRunner(script: AgentEvent[], counter: { runs: number }): A2aTaskRunner {
  return {
    async *run() {
      counter.runs += 1;
      for (const e of script) yield e;
    },
  };
}

/** A runner whose stream never completes — holds a lease open (concurrency test). */
export function hangingRunner(counter: { runs: number }): A2aTaskRunner {
  return {
    async *run() {
      counter.runs += 1;
      await new Promise<void>(() => {});
      // Never reached — the generator hangs so the caller's lease stays held.
      yield { type: 'done', text: '', turnCount: 0 };
    },
  };
}

/** A runner that records the `opts` it was invoked with (plan T0.2). */
export function capturingRunner(
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

export const HELLO_SCRIPT: AgentEvent[] = [
  { type: 'thinking_delta', thinking: 'secret internal reasoning' },
  { type: 'text_delta', text: 'hello ' },
  { type: 'text_delta', text: 'world' },
  { type: 'done', text: 'hello world', turnCount: 1 },
];

export function signPop(peer: Agent, method: string, jti: string, timestamp: number): string {
  return signStruct({ context: 'a2a-request-pop', method, jti, timestamp }, peer.privateKeyPem);
}

export const TARGET_ID = 'researcher';

export async function mintPeerToken(
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

export function newPeerStore(): StorageA2aPeerStore {
  return new StorageA2aPeerStore(new InMemoryStorage(), '/ethos/a2a');
}

export { A2A_METHOD_MESSAGE_SEND };
