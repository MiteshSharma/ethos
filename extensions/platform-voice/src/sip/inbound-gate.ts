// Inbound call hardening — the four gates a ringing phone passes before any
// provider socket is opened (voice V4, eng-review D12).
//
// A phone number is a cost surface with no login: every stranger who dials it
// can spend realtime-provider minutes, and an autodialer can spend them at
// machine speed. So the gates here are ordered CHEAPEST-REFUSAL-FIRST — budget,
// then rate limit, then concurrency, then allowlist — and a refusal never holds
// a resource, because a limiter that leaks a slot per refused call degrades to
// a denial of service after exactly `cap` refusals.
//
// Everything is pure with an injectable clock: no timers, no globals, no
// process-lifetime state beyond what the caller holds. That is what lets the
// app layer own the lifetime (one limiter per gateway, one budget per day) and
// lets a test drive a full hour or a day boundary in microseconds.

import { matchesVoicePattern } from './inbound-dispatch';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Is this caller on the operator's allowlist? Patterns use the same `*`
 * wildcard grammar as `voice.bots[].match`.
 *
 * An absent or empty allowlist returns FALSE — nobody is allowlisted. "Everyone
 * is trusted" is deliberately NOT expressible here: a key that fails to parse,
 * a typo'd config section and a genuinely empty list are indistinguishable at
 * this seam, and the failure mode of guessing "trusted" is a stranger reaching
 * the owner's memory and tools. An operator who wants every caller treated as
 * known writes `'*'`.
 */
export function isAllowlistedCaller(
  from: string,
  patterns: readonly string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => matchesVoicePattern(from, pattern));
}

export interface CallConcurrencyLimiter {
  tryAcquire(callId: string): boolean;
  release(callId: string): void;
  active(): number;
}

/**
 * Caps simultaneous live calls. Re-acquiring an id already held succeeds
 * without consuming a second slot — providers retry webhooks, and a retry for a
 * call that is already up must not count twice.
 */
export function createCallConcurrencyLimiter(opts: { cap: number }): CallConcurrencyLimiter {
  const held = new Set<string>();
  return {
    tryAcquire(callId: string): boolean {
      if (held.has(callId)) return true;
      if (held.size >= opts.cap) return false;
      held.add(callId);
      return true;
    },
    release(callId: string): void {
      held.delete(callId);
    },
    active(): number {
      return held.size;
    },
  };
}

export interface PerCallerRateLimiter {
  tryConsume(caller: string): boolean;
}

/**
 * Sliding one-hour window per caller. Memory is bounded by pruning on every
 * consume: a caller with no events left in the window is dropped entirely, so a
 * dialer sweeping a million numbers cannot grow this map without bound.
 */
export function createPerCallerRateLimiter(opts: {
  perHour: number;
  now?: () => number;
}): PerCallerRateLimiter {
  const events = new Map<string, number[]>();
  const clock = opts.now ?? Date.now;
  return {
    tryConsume(caller: string): boolean {
      const now = clock();
      const cutoff = now - HOUR_MS;
      for (const [key, times] of events) {
        const kept = times.filter((t) => t > cutoff);
        if (kept.length === 0) events.delete(key);
        else events.set(key, kept);
      }
      const mine = events.get(caller) ?? [];
      if (mine.length >= opts.perHour) return false;
      mine.push(now);
      events.set(caller, mine);
      return true;
    },
  };
}

export interface VoiceDailyBudget {
  record(usd: number): void;
  spent(): number;
  exceeded(): boolean;
  remaining(): number;
}

/**
 * Global spend ceiling for voice, reset on the UTC day boundary. UTC rather
 * than local time because the reset must be the same instant on every node
 * sharing a deployment — a per-node local midnight would let a two-node
 * deployment spend two budgets.
 *
 * `limitUsd` absent means UNLIMITED: a budget nobody configured must not refuse
 * calls. That is the opposite default from the allowlist, and deliberately so —
 * an unset allowlist risks disclosure, an unset budget risks only spend the
 * operator never asked to cap.
 */
export function createVoiceDailyBudget(opts: {
  limitUsd?: number;
  now?: () => number;
}): VoiceDailyBudget {
  const clock = opts.now ?? Date.now;
  let day = Math.floor(clock() / DAY_MS);
  let total = 0;

  const rollover = (): void => {
    const today = Math.floor(clock() / DAY_MS);
    if (today !== day) {
      day = today;
      total = 0;
    }
  };

  return {
    record(usd: number): void {
      rollover();
      total += usd;
    },
    spent(): number {
      rollover();
      return total;
    },
    exceeded(): boolean {
      rollover();
      return opts.limitUsd !== undefined && total >= opts.limitUsd;
    },
    remaining(): number {
      rollover();
      return opts.limitUsd === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, opts.limitUsd - total);
    },
  };
}

export type InboundCallDecision =
  | { accept: true; restricted: boolean; prewarm: boolean }
  | {
      accept: false;
      reason: 'not_allowlisted' | 'over_concurrency' | 'rate_limited' | 'over_budget';
    };

export interface InboundCallDecisionInput {
  from: string;
  allowlist?: readonly string[];
  /** 'allowlisted' (default) | 'none' | 'all' — who gets a pre-warmed provider socket on RING. */
  prewarm?: 'allowlisted' | 'none' | 'all';
  /** When false, a non-allowlisted caller is REFUSED instead of being screened into the receptionist scope. */
  receptionist: boolean;
  concurrency: CallConcurrencyLimiter;
  rateLimit?: PerCallerRateLimiter;
  budget?: VoiceDailyBudget;
  callId: string;
}

/**
 * The single decision an inbound call passes through. Order is load-bearing:
 * budget -> rate limit -> concurrency -> allowlist. The two global refusals
 * come first so a deployment already over budget answers nothing at all; the
 * concurrency slot is taken LAST among the resource checks and released again
 * the moment a later check refuses, so a wall of refused calls leaves
 * `active()` at zero.
 *
 * `restricted: true` means "not allowlisted" — the receptionist scope flag the
 * dispatcher uses to run the turn without owner memory or privileged tools.
 * `prewarm` opens a provider socket on RING, which costs money on a call that
 * may still be screened, so the default `'allowlisted'` policy pre-warms only
 * for callers the operator already knows (eng-review D12).
 */
export function decideInboundCall(input: InboundCallDecisionInput): InboundCallDecision {
  if (input.budget?.exceeded()) return { accept: false, reason: 'over_budget' };
  if (input.rateLimit && !input.rateLimit.tryConsume(input.from)) {
    return { accept: false, reason: 'rate_limited' };
  }
  if (!input.concurrency.tryAcquire(input.callId)) {
    return { accept: false, reason: 'over_concurrency' };
  }

  const allowlisted = isAllowlistedCaller(input.from, input.allowlist);
  if (!allowlisted && !input.receptionist) {
    input.concurrency.release(input.callId);
    return { accept: false, reason: 'not_allowlisted' };
  }

  const policy = input.prewarm ?? 'allowlisted';
  const prewarm = policy === 'all' ? true : policy === 'none' ? false : allowlisted;
  return { accept: true, restricted: !allowlisted, prewarm };
}
