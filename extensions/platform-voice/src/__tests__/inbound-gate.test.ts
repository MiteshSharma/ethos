import { describe, expect, it } from 'vitest';
import {
  createCallConcurrencyLimiter,
  createPerCallerRateLimiter,
  createVoiceDailyBudget,
  decideInboundCall,
  isAllowlistedCaller,
} from '../sip/inbound-gate';
import { makeClock } from './fakes';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

describe('isAllowlistedCaller', () => {
  it('matches exact numbers and wildcard patterns', () => {
    expect(isAllowlistedCaller('+15551234567', ['+15551234567'])).toBe(true);
    expect(isAllowlistedCaller('+15551234567', ['+1666*', '+1555*'])).toBe(true);
    expect(isAllowlistedCaller('+17770000000', ['+1555*'])).toBe(false);
  });

  // "Everyone is trusted" is not expressible: a mis-parsed key and an empty
  // list look identical here, and guessing "trusted" hands a stranger the
  // owner's memory. An operator who means it writes '*'.
  it('fails closed on an absent or empty allowlist', () => {
    expect(isAllowlistedCaller('+15551234567', undefined)).toBe(false);
    expect(isAllowlistedCaller('+15551234567', [])).toBe(false);
    expect(isAllowlistedCaller('+15551234567', ['*'])).toBe(true);
  });
});

describe('createCallConcurrencyLimiter', () => {
  it('caps simultaneous calls and frees a slot on release', () => {
    const limiter = createCallConcurrencyLimiter({ cap: 2 });
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('b')).toBe(true);
    expect(limiter.tryAcquire('c')).toBe(false);
    expect(limiter.active()).toBe(2);

    limiter.release('a');
    expect(limiter.tryAcquire('c')).toBe(true);
    expect(limiter.active()).toBe(2);
  });

  it('is idempotent for an id it already holds (a retried webhook)', () => {
    const limiter = createCallConcurrencyLimiter({ cap: 1 });
    expect(limiter.tryAcquire('call-1')).toBe(true);
    expect(limiter.tryAcquire('call-1')).toBe(true);
    expect(limiter.active()).toBe(1);
    expect(limiter.tryAcquire('call-2')).toBe(false);
  });
});

describe('createPerCallerRateLimiter', () => {
  it('limits per caller, not globally', () => {
    const limiter = createPerCallerRateLimiter({ perHour: 1, now: () => 0 });
    expect(limiter.tryConsume('+1555')).toBe(true);
    expect(limiter.tryConsume('+1555')).toBe(false);
    expect(limiter.tryConsume('+1666')).toBe(true);
  });

  it('rolls the window at exactly one hour', () => {
    const clock = makeClock();
    const limiter = createPerCallerRateLimiter({ perHour: 1, now: clock.now });

    expect(limiter.tryConsume('+1555')).toBe(true);
    clock.advance(HOUR_MS - 1);
    expect(limiter.tryConsume('+1555')).toBe(false);
    clock.advance(1);
    expect(limiter.tryConsume('+1555')).toBe(true);
  });

  it('evicts callers with no events left in the window', () => {
    const clock = makeClock();
    const limiter = createPerCallerRateLimiter({ perHour: 2, now: clock.now });
    for (let i = 0; i < 100; i++) limiter.tryConsume(`+1555000${i}`);
    clock.advance(HOUR_MS + 1);
    // The pruned callers are gone; a fresh caller still gets its full budget.
    expect(limiter.tryConsume('+15550000')).toBe(true);
    expect(limiter.tryConsume('+15550000')).toBe(true);
    expect(limiter.tryConsume('+15550000')).toBe(false);
  });
});

describe('createVoiceDailyBudget', () => {
  it('never exceeds when no limit is configured', () => {
    const budget = createVoiceDailyBudget({ now: () => 0 });
    budget.record(1000);
    expect(budget.exceeded()).toBe(false);
    expect(budget.remaining()).toBe(Number.POSITIVE_INFINITY);
    expect(budget.spent()).toBe(1000);
  });

  it('tracks spend against the limit', () => {
    const budget = createVoiceDailyBudget({ limitUsd: 5, now: () => 0 });
    budget.record(2);
    expect(budget.remaining()).toBe(3);
    expect(budget.exceeded()).toBe(false);
    budget.record(3);
    expect(budget.exceeded()).toBe(true);
    expect(budget.remaining()).toBe(0);
  });

  it('resets on the UTC day boundary', () => {
    const clock = makeClock();
    // Start mid-day so the boundary crossing is a real one, not t=0.
    clock.advance(DAY_MS * 10 + 3_600_000);
    const budget = createVoiceDailyBudget({ limitUsd: 5, now: clock.now });
    budget.record(6);
    expect(budget.exceeded()).toBe(true);

    clock.advance(DAY_MS);
    expect(budget.spent()).toBe(0);
    expect(budget.exceeded()).toBe(false);
    expect(budget.remaining()).toBe(5);
  });
});

describe('decideInboundCall', () => {
  const allowlist = ['+1555*'];
  const known = '+15551234567';
  const stranger = '+19998887777';

  function gate(overrides: Partial<Parameters<typeof decideInboundCall>[0]> = {}) {
    return decideInboundCall({
      from: known,
      allowlist,
      receptionist: true,
      concurrency: createCallConcurrencyLimiter({ cap: 2 }),
      callId: 'call-1',
      ...overrides,
    });
  }

  it('accepts an allowlisted caller unrestricted and pre-warmed', () => {
    expect(gate()).toEqual({ accept: true, restricted: false, prewarm: true });
  });

  it('screens a non-allowlisted caller into the receptionist scope', () => {
    expect(gate({ from: stranger })).toEqual({
      accept: true,
      restricted: true,
      // No provider spend on a call that may still be screened (eng-review D12).
      prewarm: false,
    });
  });

  it('refuses a non-allowlisted caller when no receptionist is configured', () => {
    expect(gate({ from: stranger, receptionist: false })).toEqual({
      accept: false,
      reason: 'not_allowlisted',
    });
  });

  it('honours the prewarm policy', () => {
    expect(gate({ from: stranger, prewarm: 'all' })).toMatchObject({ prewarm: true });
    expect(gate({ from: known, prewarm: 'none' })).toMatchObject({ prewarm: false });
    expect(gate({ from: stranger, prewarm: 'none' })).toMatchObject({ prewarm: false });
  });

  it('refuses over the concurrency cap', () => {
    const concurrency = createCallConcurrencyLimiter({ cap: 1 });
    expect(gate({ concurrency, callId: 'a' }).accept).toBe(true);
    expect(gate({ concurrency, callId: 'b' })).toEqual({
      accept: false,
      reason: 'over_concurrency',
    });
  });

  it('refuses over the per-caller rate limit', () => {
    const rateLimit = createPerCallerRateLimiter({ perHour: 1, now: () => 0 });
    expect(gate({ rateLimit, callId: 'a' }).accept).toBe(true);
    expect(gate({ rateLimit, callId: 'b' })).toEqual({ accept: false, reason: 'rate_limited' });
  });

  it('refuses when the daily budget is exhausted', () => {
    const budget = createVoiceDailyBudget({ limitUsd: 1, now: () => 0 });
    budget.record(1);
    expect(gate({ budget })).toEqual({ accept: false, reason: 'over_budget' });
  });

  // Order is load-bearing: the global refusals come first so an over-budget
  // deployment answers nothing, and neither of them may consume a call slot.
  it('checks budget -> rate limit -> concurrency -> allowlist', () => {
    const concurrency = createCallConcurrencyLimiter({ cap: 0 });
    const rateLimit = createPerCallerRateLimiter({ perHour: 0, now: () => 0 });
    const budget = createVoiceDailyBudget({ limitUsd: 1, now: () => 0 });
    budget.record(1);

    // All four would refuse; budget wins.
    expect(
      gate({ from: stranger, receptionist: false, concurrency, rateLimit, budget }),
    ).toMatchObject({ reason: 'over_budget' });

    // Budget clear; rate limit wins over concurrency and allowlist.
    const clearBudget = createVoiceDailyBudget({ limitUsd: 10, now: () => 0 });
    expect(
      gate({ from: stranger, receptionist: false, concurrency, rateLimit, budget: clearBudget }),
    ).toMatchObject({ reason: 'rate_limited' });

    // Rate limit clear; concurrency wins over allowlist.
    const openRate = createPerCallerRateLimiter({ perHour: 10, now: () => 0 });
    expect(
      gate({
        from: stranger,
        receptionist: false,
        concurrency,
        rateLimit: openRate,
        budget: clearBudget,
      }),
    ).toMatchObject({ reason: 'over_concurrency' });
  });

  // A limiter that leaks a slot per refused call degrades to a denial of
  // service after exactly `cap` refusals.
  it('releases the concurrency slot when a later check refuses', () => {
    const concurrency = createCallConcurrencyLimiter({ cap: 2 });
    for (let i = 0; i < 3; i++) {
      expect(
        gate({ from: stranger, receptionist: false, concurrency, callId: `call-${i}` }),
      ).toEqual({ accept: false, reason: 'not_allowlisted' });
    }
    expect(concurrency.active()).toBe(0);
    // The cap is intact — an allowlisted caller still gets in.
    expect(gate({ concurrency, callId: 'later' }).accept).toBe(true);
  });
});
