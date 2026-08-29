import { describe, expect, it } from 'vitest';
import { createCallConcurrencyLimiter, decideInboundCall } from '../sip/inbound-gate';

// T11b — plan/phases/settings-navigation.md §7, §10. A NAMED, DEDICATED
// regression pin, distinct from `inbound-gate.test.ts`'s general coverage
// (its 'honours the prewarm policy' case), tied specifically to the §7
// finding that `voice.inbound.prewarm` LOOKS live and is not: the policy
// resolves correctly all the way to `decideInboundCall`'s return value, and
// NOTHING downstream ever acts on it — `SipRealtimeBridge.prewarm()` has zero
// production call sites, because `createSipRealtimeBridge` is never
// constructed outside its own tests (already recorded in TESTING.md:864).
//
// Settings → Voice renders the "Accepted, currently unread" callout on this
// field (Phase 7, `settings-callouts.test.ts`), which is a claim about the
// WHOLE chain. This file pins the half of that chain that must hold
// regardless of whether anyone ever wires the bridge up: the policy
// resolution itself.
//
// What this file deliberately does NOT assert — and must not gain, even as a
// "helpful" addition — is anything about `SipRealtimeBridge.prewarm()`,
// `createSipRealtimeBridge`, or the absence of a production call site for
// either. That assertion would be green today, but it turns green into RED
// the day somebody fixes the bug by wiring the bridge up, which would punish
// the repair and reward leaving the setting dead. See plan §10, "What T11b
// deliberately does not assert".

describe('decideInboundCall — the prewarm policy resolves, regardless of what (if anything) acts on it', () => {
  const allowlist = ['+1555*'];
  const allowlisted = '+15551234567';
  const stranger = '+19998887777';

  function gate(overrides: Partial<Parameters<typeof decideInboundCall>[0]> = {}) {
    return decideInboundCall({
      from: allowlisted,
      allowlist,
      receptionist: true,
      concurrency: createCallConcurrencyLimiter({ cap: 2 }),
      callId: 'call-1',
      ...overrides,
    });
  }

  it('"all" resolves to true regardless of allowlist status', () => {
    expect(gate({ from: allowlisted, prewarm: 'all' })).toMatchObject({ prewarm: true });
    expect(gate({ from: stranger, prewarm: 'all' })).toMatchObject({ prewarm: true });
  });

  it('"none" resolves to false regardless of allowlist status', () => {
    expect(gate({ from: allowlisted, prewarm: 'none' })).toMatchObject({ prewarm: false });
    expect(gate({ from: stranger, prewarm: 'none' })).toMatchObject({ prewarm: false });
  });

  it('"allowlisted" resolves to the allowlist result', () => {
    expect(gate({ from: allowlisted, prewarm: 'allowlisted' })).toMatchObject({ prewarm: true });
    expect(gate({ from: stranger, prewarm: 'allowlisted', receptionist: true })).toMatchObject({
      prewarm: false,
    });
  });

  it('omitting prewarm defaults to "allowlisted", same as spelling it out', () => {
    expect(gate({ from: allowlisted, prewarm: undefined })).toMatchObject({ prewarm: true });
    expect(gate({ from: stranger, prewarm: undefined, receptionist: true })).toMatchObject({
      prewarm: false,
    });
  });
});
