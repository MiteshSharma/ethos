// Gate #2 of `plan/phases/clock-tolerance-pass.md` — the delivery-ledger
// abandon window. If a host pause alone exceeds `abandonAfterDays`, the first
// post-resume sweep abandons an obligation that was never lost, and for voice
// DELETES its audio artifact. `Gateway.applyPauseOffset` discounts the pause
// from the cutoff `pruneVoiceArtifacts` hands to `abandonStale`.

import type { DeliveryLedger, DeliveryObligation } from '@ethosagent/delivery-ledger';
import { describe, expect, it } from 'vitest';
import { Gateway } from '../index';
import type { VoiceArtifactStore } from '../voice-artifacts';
import { stubLoop } from './voice-fakes';

const DAY_MS = 86_400_000;

/** A ledger that records the cutoff it was asked to abandon against. */
function spyLedger(): DeliveryLedger & { cutoffs: number[] } {
  const cutoffs: number[] = [];
  const ledger = {
    cutoffs,
    record: async () => 'id',
    listPending: async (): Promise<DeliveryObligation[]> => [],
    claim: async () => false,
    markDelivered: async () => {},
    release: async () => {},
    get: async () => null,
    abandonStale: async (_botKeys: readonly string[], cutoffMs: number) => {
      cutoffs.push(cutoffMs);
      return [] as DeliveryObligation[];
    },
    pruneDelivered: async () => 0,
    stats: async () => ({}),
    listRecent: async (): Promise<DeliveryObligation[]> => [],
  };
  return ledger as unknown as DeliveryLedger & { cutoffs: number[] };
}

function noopArtifacts(): VoiceArtifactStore {
  return {
    put: async () => null,
    read: async () => null,
    remove: async () => {},
    enforceSizeCap: async () => 0,
  };
}

function harness() {
  const ledger = spyLedger();
  const gateway = new Gateway({
    bots: [
      { botKey: 'bot-a', loop: stubLoop(), binding: { type: 'personality', name: 'default' } },
    ],
    deliveryLedger: ledger,
    voiceArtifacts: noopArtifacts(),
    clarifySweepIntervalMs: 0,
  });
  return { ledger, gateway };
}

describe('Gateway.applyPauseOffset — abandonStale cutoff', () => {
  it('without an offset the cutoff is abandonAfterDays before now', async () => {
    const { ledger, gateway } = harness();

    const before = Date.now();
    await gateway.pruneVoiceArtifacts({ abandonAfterDays: 14, maxTotalMb: 100 });
    const after = Date.now();

    expect(ledger.cutoffs).toHaveLength(1);
    const cutoff = ledger.cutoffs[0] ?? 0;
    expect(cutoff).toBeGreaterThanOrEqual(before - 14 * DAY_MS);
    expect(cutoff).toBeLessThanOrEqual(after - 14 * DAY_MS);
  });

  it('THE FIX: the cutoff is pushed back by exactly the accumulated pause', async () => {
    const { ledger, gateway } = harness();

    await gateway.pruneVoiceArtifacts({ abandonAfterDays: 14, maxTotalMb: 100 });
    const baseline = ledger.cutoffs[0] ?? 0;

    gateway.applyPauseOffset(3 * DAY_MS);
    gateway.applyPauseOffset(4 * DAY_MS);

    const before = Date.now();
    await gateway.pruneVoiceArtifacts({ abandonAfterDays: 14, maxTotalMb: 100 });
    const after = Date.now();

    const shifted = ledger.cutoffs[1] ?? 0;
    // Offsets accumulate to 7 days; allow for wall-clock drift between calls.
    expect(shifted).toBeGreaterThanOrEqual(baseline - 7 * DAY_MS - (after - before) - 5);
    expect(shifted).toBeLessThanOrEqual(baseline - 7 * DAY_MS + (after - before) + 5);
  });

  it('non-positive and non-finite durations are a no-op', async () => {
    const { ledger, gateway } = harness();

    gateway.applyPauseOffset(0);
    gateway.applyPauseOffset(-7 * DAY_MS);
    gateway.applyPauseOffset(Number.NaN);
    gateway.applyPauseOffset(Number.POSITIVE_INFINITY);

    const before = Date.now();
    await gateway.pruneVoiceArtifacts({ abandonAfterDays: 14, maxTotalMb: 100 });
    const after = Date.now();

    const cutoff = ledger.cutoffs[0] ?? 0;
    expect(cutoff).toBeGreaterThanOrEqual(before - 14 * DAY_MS);
    expect(cutoff).toBeLessThanOrEqual(after - 14 * DAY_MS);
  });
});

// Codex review finding: the offset was held forever and subtracted from EVERY
// later sweep, so one long pause silently extended retention for obligations
// created long after it, compounding with each pause until nothing was ever
// abandoned. Plan §2 words this gate as "the first post-resume sweep".
describe('Gateway.applyPauseOffset — spent on the first sweep, not held', () => {
  const OPTS = { abandonAfterDays: 14, maxTotalMb: 100 };

  it('does not widen the cutoff of a second sweep', async () => {
    const { ledger, gateway } = harness();

    gateway.applyPauseOffset(7 * DAY_MS);
    await gateway.pruneVoiceArtifacts(OPTS);
    await gateway.pruneVoiceArtifacts(OPTS);

    expect(ledger.cutoffs).toHaveLength(2);
    const [first, second] = ledger.cutoffs as [number, number];
    // The second sweep is back to the plain 14-day window — a whole pause newer
    // than the first. Held forever, the two would have been ~equal.
    expect(second - first).toBeGreaterThan(7 * DAY_MS - 5_000);
  });

  it('re-widens after a NEW pause — the correction is not once-per-process', async () => {
    const { ledger, gateway } = harness();

    gateway.applyPauseOffset(DAY_MS);
    await gateway.pruneVoiceArtifacts(OPTS);
    await gateway.pruneVoiceArtifacts(OPTS);
    gateway.applyPauseOffset(DAY_MS);
    await gateway.pruneVoiceArtifacts(OPTS);

    const [first, , third] = ledger.cutoffs as [number, number, number];
    expect(Math.abs(third - first)).toBeLessThan(5_000);
  });
});
