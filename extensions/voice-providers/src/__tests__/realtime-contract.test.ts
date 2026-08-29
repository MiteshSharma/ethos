import { beforeAll, describe, expect, it } from 'vitest';
import {
  createFakeRealtimeServer,
  REALTIME_CONTRACT_CHECKS,
  runRealtimeContractSuite,
} from '../realtime-conformance';
import { registerBuiltInRealtimeProviders } from '../realtime-registry';
import { REALTIME_CONFORMANCE_TARGETS } from './realtime-targets';
import { TestRealtimeRegistry } from './test-realtime-registry';

// The behavioural half of the realtime contract, driven by the REGISTRY rather
// than by two hand-written opt-ins.
//
// Each provider used to enrol itself in this suite from its own test file,
// which meant a third provider added to the registry would ship with zero
// behavioural coverage and nothing would say so. Here the roster comes from
// `registry.list()`: a provider that is registered is tested, and a provider
// with no wire vocabulary in `REALTIME_CONFORMANCE_TARGETS` fails every check
// instead of quietly running none. Per-provider details that are NOT contract
// (model pinning, headers, handshake shape) stay in the per-provider files.

const registry = new TestRealtimeRegistry();
registerBuiltInRealtimeProviders(registry);
const registered = registry.list();

/** Registered providers with no wire vocabulary to drive the suite with. */
function targetsMissingFor(ids: readonly string[]): string[] {
  return ids.filter((id) => REALTIME_CONFORMANCE_TARGETS[id] === undefined);
}

describe('realtime contract coverage', () => {
  it('has a conformance target for every registered provider', () => {
    expect(targetsMissingFor(registered)).toEqual([]);
  });

  it('names a registered provider that arrives without one', () => {
    // The guard above only bites if it can actually see an omission — this is
    // that proof, with a provider id the registry has never heard of.
    expect(targetsMissingFor([...registered, 'ghost-realtime'])).toEqual(['ghost-realtime']);
  });
});

describe.each(registered)('%s — shared realtime contract suite', (id) => {
  let results: Map<string, string[]>;

  beforeAll(async () => {
    const target = REALTIME_CONFORMANCE_TARGETS[id];
    // No target → an EMPTY result map, so every check below reports "the check
    // did not run" and FAILS. Skipping is the one outcome a contract suite must
    // never have: an absent result reads exactly like a green one.
    const checks = target ? await runRealtimeContractSuite(target) : [];
    results = new Map(checks.map((check) => [check.name, check.errors]));
  });

  it('is described by a target that builds this registered provider', async () => {
    const target = REALTIME_CONFORMANCE_TARGETS[id];
    expect(target).toBeDefined();
    // Keyed by the REGISTERED id, so a target filed under the wrong key (or
    // pointed at the wrong class) cannot pass by driving some other provider.
    const provider = await target?.createProvider(createFakeRealtimeServer().factory);
    expect(provider?.name).toBe(id);
  });

  for (const name of REALTIME_CONTRACT_CHECKS) {
    it(name, () => {
      expect(results.get(name) ?? ['the check did not run']).toEqual([]);
    });
  }
});
