// A2A per-peer limiter (plan §O6 / §12, Phase 6) — the real limiter that
// replaces Phase 5's no-op hook.
//
// TWO DISTINCT caps, because they defend against two different attacks (plan
// §O6):
//
//   - RATE       — a peer hammering request rate. A sliding window of recent
//                  acquisitions; the (rate+1)-th within the window is rejected.
//   - CONCURRENCY — a peer holding many long-running tasks open at once. Bounded
//                  by outstanding (un-released) leases; the (cap+1)-th concurrent
//                  task is rejected even if the rate is fine.
//
// A rejection returns `null` from `acquire` — the RPC layer maps that to the
// typed JSON-RPC busy error (`-32004` rate-limited). This is the §12
// blast-radius seam: A2A gets its OWN isolatable limiter so A2A abuse cannot
// take down `/rpc`.
//
// Layer-clean: implements the `A2aLimiter` interface from `./rpc`; imports
// nothing but that type. In-process counters (single-process v1).

import type { A2aLease, A2aLimiter } from './rpc';

// ---------------------------------------------------------------------------
// Pre-auth limiter (plan T1.4) — a SEPARATE, cheaper gate that runs BEFORE
// `authenticate()`, not a replacement for `MemoryA2aLimiter` above. The two
// enforce different things: this one bounds CPU spent on Ed25519/JWT
// verification for callers who have not yet proven anything at all (keyed on
// remote address, coarse, no concurrency tracking); `MemoryA2aLimiter` bounds
// an AUTHENTICATED peer's rate + concurrency. Both run on every request.
// ---------------------------------------------------------------------------

/**
 * A cheap, coarse admission check keyed on an opaque caller-supplied string
 * (in practice the remote address). `check` must be synchronous-cheap — no
 * I/O, no crypto — because its entire purpose is to reject a flood BEFORE any
 * expensive work runs. Returns `false` → the caller must reject the request
 * without calling `authenticate()`.
 */
export interface A2aPreAuthLimiter {
  check(key: string): boolean;
}

export interface MemoryA2aPreAuthLimiterOptions {
  /** Max checks per key within `windowMs`. Default 20. */
  maxPerWindow?: number;
  /** Sliding-window length in ms. Default 10_000. */
  windowMs?: number;
  /** Injectable clock (ms epoch). Default `Date.now`. */
  now?: () => number;
}

/**
 * In-process sliding-window pre-auth limiter, keyed by an arbitrary string
 * (the router supplies the remote address; see `rpc.ts`'s `readCredentials`).
 * Deliberately simpler than {@link MemoryA2aLimiter}: no lease/release, no
 * concurrency tracking — a flood gate, not a fairness scheduler.
 */
export class MemoryA2aPreAuthLimiter implements A2aPreAuthLimiter {
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  // key -> ms-epoch timestamps of checks still inside the window.
  private readonly recent = new Map<string, number[]>();

  constructor(opts: MemoryA2aPreAuthLimiterOptions = {}) {
    this.maxPerWindow = opts.maxPerWindow ?? 20;
    this.windowMs = opts.windowMs ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  check(key: string): boolean {
    const nowMs = this.now();
    const cutoff = nowMs - this.windowMs;
    let bucket = this.recent.get(key);
    if (!bucket) {
      bucket = [];
      this.recent.set(key, bucket);
    }
    while (bucket.length > 0 && (bucket[0] ?? 0) <= cutoff) bucket.shift();
    if (bucket.length >= this.maxPerWindow) return false;
    bucket.push(nowMs);
    return true;
  }
}

export const NOOP_PRE_AUTH_LIMITER: A2aPreAuthLimiter = {
  check() {
    return true;
  },
};

export interface MemoryA2aLimiterOptions {
  /** Max simultaneously-outstanding leases per peer. Default 4. */
  maxConcurrentPerPeer?: number;
  /** Max acquisitions per peer within `windowMs`. Default 30. */
  ratePerWindow?: number;
  /** Sliding-window length in ms for the rate cap. Default 60_000. */
  windowMs?: number;
  /** Injectable clock (ms epoch). Default `Date.now`. */
  now?: () => number;
}

interface PeerBucket {
  /** ms-epoch timestamps of acquisitions still inside the window. */
  recent: number[];
  /** Count of outstanding (acquired, not-yet-released) leases. */
  active: number;
}

/**
 * In-process per-peer limiter keyed by `(personalityId, peerFingerprint)`. Both
 * caps are checked on every `acquire`; a granted lease increments the active
 * count and records the timestamp, and `release` decrements the active count.
 */
export class MemoryA2aLimiter implements A2aLimiter {
  private readonly maxConcurrent: number;
  private readonly ratePerWindow: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, PeerBucket>();

  constructor(opts: MemoryA2aLimiterOptions = {}) {
    this.maxConcurrent = opts.maxConcurrentPerPeer ?? 4;
    this.ratePerWindow = opts.ratePerWindow ?? 30;
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  async acquire(personalityId: string, peerFingerprint: string): Promise<A2aLease | null> {
    const key = `${personalityId} ${peerFingerprint}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { recent: [], active: 0 };
      this.buckets.set(key, bucket);
    }

    const nowMs = this.now();
    const cutoff = nowMs - this.windowMs;
    // Evict window-expired timestamps (in-order, oldest first).
    while (bucket.recent.length > 0 && (bucket.recent[0] ?? 0) <= cutoff) bucket.recent.shift();

    // Concurrency cap — a distinct check from rate.
    if (bucket.active >= this.maxConcurrent) return null;
    // Rate cap.
    if (bucket.recent.length >= this.ratePerWindow) return null;

    bucket.recent.push(nowMs);
    bucket.active += 1;
    const b = bucket;
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        b.active = Math.max(0, b.active - 1);
      },
    };
  }
}
