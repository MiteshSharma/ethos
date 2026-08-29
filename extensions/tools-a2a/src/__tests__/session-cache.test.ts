// Unit tests for the T1.2 session/token cache, isolated from the tool + HTTP.

import type { A2aSession } from '@ethosagent/a2a';
import type { AgentCard } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { A2aSessionCache } from '../session-cache';

const P = 'researcher';
const URL_A = 'https://peer-a.example/.well-known/agent-card.json';

function makeSession(fingerprint: string, expiresAt: number): A2aSession {
  const card = { keyFingerprint: fingerprint } as AgentCard;
  return { peerCard: card, token: `tok-${fingerprint}`, expiresAt };
}

describe('A2aSessionCache — get/set (plan T1.2)', () => {
  it('returns null on a miss and the session on a hit', () => {
    const cache = new A2aSessionCache({ now: () => 1_000 });
    expect(cache.get(P, 'fp-1')).toBeNull();

    const session = makeSession('fp-1', 100_000);
    cache.set(P, URL_A, session);
    expect(cache.get(P, 'fp-1')).toBe(session);
  });

  it('keys are scoped per personalityId — a different personality is a miss', () => {
    const cache = new A2aSessionCache({ now: () => 1_000 });
    cache.set(P, URL_A, makeSession('fp-1', 100_000));
    expect(cache.get('other-personality', 'fp-1')).toBeNull();
  });
});

describe('A2aSessionCache — expiry with safety margin (plan T1.2)', () => {
  it('treats a token as stale inside the safety margin, not just past literal expiry', () => {
    let t = 0;
    const cache = new A2aSessionCache({ now: () => t, expirySafetyMarginMs: 5_000 });
    cache.set(P, URL_A, makeSession('fp-1', 10_000));

    t = 4_000; // 6s of life left — outside the 5s margin, still valid.
    expect(cache.get(P, 'fp-1')).not.toBeNull();

    t = 5_001; // <5s of life left — inside the margin, treated as stale.
    expect(cache.get(P, 'fp-1')).toBeNull();
  });

  it('evicts a lazily-discovered-expired entry so it does not linger', () => {
    let t = 0;
    const cache = new A2aSessionCache({ now: () => t, expirySafetyMarginMs: 0 });
    cache.set(P, URL_A, makeSession('fp-1', 10_000));
    t = 10_000;
    expect(cache.get(P, 'fp-1')).toBeNull();
    // A second read at the same time confirms the entry is gone, not re-derived.
    expect(cache.get(P, 'fp-1')).toBeNull();
  });
});

describe('A2aSessionCache — peer_url index (plan T1.2)', () => {
  it('resolves a fingerprint from a prior set() so a repeat call can omit it', () => {
    const cache = new A2aSessionCache({ now: () => 0 });
    expect(cache.resolveFingerprint(P, URL_A)).toBeUndefined();

    cache.set(P, URL_A, makeSession('fp-1', 100_000));
    expect(cache.resolveFingerprint(P, URL_A)).toBe('fp-1');
  });
});

describe('A2aSessionCache — invalidate (plan T1.2 / D13)', () => {
  it('removes the entry so the next get() is a miss', () => {
    const cache = new A2aSessionCache({ now: () => 0 });
    cache.set(P, URL_A, makeSession('fp-1', 100_000));
    expect(cache.get(P, 'fp-1')).not.toBeNull();

    cache.invalidate(P, 'fp-1');
    expect(cache.get(P, 'fp-1')).toBeNull();
  });
});
