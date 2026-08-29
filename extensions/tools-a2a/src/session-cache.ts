// Session/token cache for `a2a_send` (plan T1.2). `A2aOutboundClient.connect()`
// runs the FULL handshake — fetch card, verify signature, check fingerprint,
// request challenge, sign response, receive token — on every call. Most sends
// go to a peer already spoken to seconds ago; this cache lets a repeat send
// within the token's lifetime skip straight to `sendMessage`.
//
// SAFETY (plan D13 — no allowlist-change notification exists in this codebase):
// the cache only ever SKIPS THE HANDSHAKE. It is never itself a trust decision.
// The allowlist is re-checked with a cheap local read on EVERY send, cache hit
// or miss, BEFORE the cached session is used — that is what makes a revoked
// peer fail closed on its very next send even though the token in cache is
// still cryptographically valid. A cache MISS always falls through to
// `connect()`, which re-verifies the card's signature and fingerprint in full;
// only a cache HIT trusts the fingerprint verified when the entry was written,
// and only for as long as the cached token remains valid (with a safety
// margin — see `expirySafetyMarginMs`).

import type { A2aSession } from '@ethosagent/a2a';

export interface A2aSessionCacheOptions {
  /** Injectable clock (ms epoch). Default `Date.now`. */
  now?: () => number;
  /**
   * Treat a cached session as stale this many ms before the token's actual
   * `expiresAt` — never hand out a token in the last few seconds of its
   * validity, where it could expire mid-flight on the peer. Default 5_000.
   */
  expirySafetyMarginMs?: number;
}

/**
 * Per-`(personalityId, peerFingerprint)` cache of a verified {@link A2aSession}
 * (card + token). Also indexes by `(personalityId, peerUrl)` so a repeat call
 * that omits the optional out-of-band `fingerprint` arg still hits the cache
 * without a network round trip — the fingerprint is only discoverable by
 * fetching the card, which is exactly the cost a HIT exists to avoid.
 */
export class A2aSessionCache {
  private readonly now: () => number;
  private readonly safetyMarginMs: number;
  private readonly byFingerprint = new Map<string, A2aSession>();
  private readonly urlIndex = new Map<string, string>();

  constructor(opts: A2aSessionCacheOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.safetyMarginMs = opts.expirySafetyMarginMs ?? 5_000;
  }

  private fpKey(personalityId: string, fingerprint: string): string {
    return `${personalityId}\x00${fingerprint}`;
  }

  private urlKey(personalityId: string, peerUrl: string): string {
    return `${personalityId}\x00${peerUrl}`;
  }

  /**
   * Resolve a peer's fingerprint from a prior successful connect at this
   * `peerUrl`, for a caller that did not supply the `fingerprint` arg on this
   * call. Returns `undefined` on no prior record — the caller must fall
   * through to a full `connect()`, which discovers the fingerprint itself.
   */
  resolveFingerprint(personalityId: string, peerUrl: string): string | undefined {
    return this.urlIndex.get(this.urlKey(personalityId, peerUrl));
  }

  /**
   * A live (unexpired, safety-margin-respecting) cached session for this peer,
   * or `null` on a miss (absent, or past its safety-margined expiry — which
   * also evicts the stale entry). Callers MUST re-check the allowlist with
   * this fingerprint before trusting the result (D13) — this method only
   * answers "do I still hold a token", never "am I still allowed to use it".
   */
  get(personalityId: string, fingerprint: string): A2aSession | null {
    const key = this.fpKey(personalityId, fingerprint);
    const entry = this.byFingerprint.get(key);
    if (!entry) return null;
    if (this.now() + this.safetyMarginMs >= entry.expiresAt) {
      this.byFingerprint.delete(key);
      return null;
    }
    return entry;
  }

  /** Cache a freshly-established session and index it by `peerUrl` too. */
  set(personalityId: string, peerUrl: string, session: A2aSession): void {
    this.byFingerprint.set(this.fpKey(personalityId, session.peerCard.keyFingerprint), session);
    this.urlIndex.set(this.urlKey(personalityId, peerUrl), session.peerCard.keyFingerprint);
  }

  /**
   * Evict a peer's cached session. Called on: an auth-rejection from the peer
   * (the token it minted is no longer good), or the peer failing this
   * personality's OWN egress allowlist check (revoked/removed — plan D13).
   * Token expiry is handled lazily by `get`, not here.
   */
  invalidate(personalityId: string, fingerprint: string): void {
    this.byFingerprint.delete(this.fpKey(personalityId, fingerprint));
  }
}
