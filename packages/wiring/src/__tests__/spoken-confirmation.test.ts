// The spoken-confirmation gate, and the one rule in it that is not negotiable:
// a far-end caller's voice can NEVER satisfy an owner-level confirmation
// (voice V1a, eng-review D13).
//
// Telephony does not exist yet, so nothing in the repo can currently construct
// a `far_end` origin. That is the point of testing it now: the gate has to be
// correct BEFORE the capability it gates ships, because the alternative is
// remembering to add it while wiring a SIP trunk.

import { DefaultHookRegistry, DefaultPersonalityRegistry } from '@ethosagent/core';
import type { BeforeToolCallPayload, VoiceTurnOrigin } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createApprovalDangerPredicate } from '../approval-seams';
import type { DangerPredicate } from '../danger-predicate';
import { APPROVAL_SURFACE_ALWAYS_ASK } from '../danger-predicate';
import {
  farEndRefusalReason,
  SPOKEN_CONFIRMATION_TOOLS,
  withSpokenConfirmation,
} from '../spoken-confirmation';

const allow: DangerPredicate = async () => null;
const refuse: DangerPredicate = async () => 'base predicate said no';

function call(
  toolName: string,
  voiceOrigin?: VoiceTurnOrigin,
  toolCallId = 'tc-1',
): BeforeToolCallPayload {
  return {
    sessionId: 's1',
    toolCallId,
    toolName,
    args: {},
    ...(voiceOrigin ? { voiceOrigin } : {}),
  };
}

const OWNER: VoiceTurnOrigin = { transport: 'browser-talk-mode', speaker: 'owner' };
const FAR_END: VoiceTurnOrigin = { transport: 'sip-inbound', speaker: 'far_end' };

describe('withSpokenConfirmation — the far-end rule', () => {
  it('refuses a far-end caller on every gated tool', async () => {
    const gate = withSpokenConfirmation(allow);
    for (const tool of SPOKEN_CONFIRMATION_TOOLS) {
      expect(await gate(call(tool, FAR_END))).toBe(farEndRefusalReason(tool));
    }
  });

  // The load-bearing assertion. A recorded confirmation is the mechanism an
  // owner uses to satisfy the gate; a far-end caller must not be able to reach
  // it, whatever confirmation state happens to exist for that call id.
  it('a recorded confirmation does NOT let a far-end caller through', async () => {
    const gate = withSpokenConfirmation(allow, {
      confirmations: { has: () => true },
    });
    const reason = await gate(call('terminal', FAR_END));
    expect(reason).toBe(farEndRefusalReason('terminal'));
    expect(reason).toMatch(/cannot authorize/i);
    // And it says where the confirmation has to happen instead.
    expect(reason).toMatch(/owner's own channel/i);
  });

  it('refuses a far-end caller even when the owner confirmed the SAME call id', async () => {
    const confirmed = new Set(['tc-42']);
    const gate = withSpokenConfirmation(allow, {
      confirmations: { has: (id) => confirmed.has(id) },
    });
    // Same id the owner confirmed, arriving from the far end.
    expect(await gate(call('call', FAR_END, 'tc-42'))).toBe(farEndRefusalReason('call'));
    // The owner's own request on that id still goes through — proving the
    // refusal above is about the SPEAKER, not about a broken confirmation.
    expect(await gate(call('call', OWNER, 'tc-42'))).toBeNull();
  });
});

describe('withSpokenConfirmation — the owner path', () => {
  it('asks the owner to re-confirm a high-impact spoken request', async () => {
    const gate = withSpokenConfirmation(allow);
    const reason = await gate(call('write_file', OWNER));
    expect(reason).toMatch(/requested out loud/i);
  });

  it('lets a re-confirmed call through', async () => {
    const gate = withSpokenConfirmation(allow, {
      confirmations: { has: (id) => id === 'tc-ok' },
    });
    expect(await gate(call('write_file', OWNER, 'tc-ok'))).toBeNull();
    expect(await gate(call('write_file', OWNER, 'tc-other'))).toMatch(/requested out loud/i);
  });

  it('ignores tools that are not high-impact', async () => {
    const gate = withSpokenConfirmation(allow);
    expect(await gate(call('read_file', OWNER))).toBeNull();
    expect(await gate(call('web_search', FAR_END))).toBeNull();
  });
});

describe('withSpokenConfirmation — composition', () => {
  it('is inert on typed turns', async () => {
    const gate = withSpokenConfirmation(allow);
    for (const tool of SPOKEN_CONFIRMATION_TOOLS) {
      expect(await gate(call(tool))).toBeNull();
    }
  });

  it('never weakens the base predicate', async () => {
    const gate = withSpokenConfirmation(refuse, {
      confirmations: { has: () => true },
    });
    // Confirmed, owner, would otherwise pass — the base reason still wins.
    expect(await gate(call('write_file', OWNER))).toBe('base predicate said no');
    expect(await gate(call('read_file'))).toBe('base predicate said no');
  });

  it('gates the union of always-ask and smart-mode consequential tools', async () => {
    // Derived, not hand-listed, so a future entry in either source list is
    // covered without anyone remembering to copy it here.
    for (const tool of ['call', 'terminal', 'write_file', 'patch_file', 'process_start']) {
      expect(SPOKEN_CONFIRMATION_TOOLS).toContain(tool);
    }
  });
});

// The gate is not opt-in: every approval surface gets it by construction.
// A surface that had to remember to wrap its own predicate is a surface that
// eventually forgets.
describe('createApprovalDangerPredicate — the gate is applied by default', () => {
  const registry = new DefaultPersonalityRegistry();

  function predicate(spokenConfirmations?: { has(id: string): boolean }) {
    return createApprovalDangerPredicate({
      hooks: [new DefaultHookRegistry()],
      personalities: registry,
      getProvider: async () => {
        throw new Error('provider must not be constructed here');
      },
      model: 'unused',
      alwaysAsk: APPROVAL_SURFACE_ALWAYS_ASK,
      ...(spokenConfirmations ? { spokenConfirmations } : {}),
    });
  }

  it('refuses a far-end caller without any extra wiring', async () => {
    expect(await predicate()(call('terminal', FAR_END))).toBe(farEndRefusalReason('terminal'));
  });

  it('requires re-confirmation for an owner speaking, and honours one when given', async () => {
    expect(await predicate()(call('terminal', OWNER))).toMatch(/requested out loud/i);
    expect(await predicate({ has: () => true })(call('terminal', OWNER))).toBeNull();
  });

  it('leaves typed turns exactly as they were', async () => {
    // `call` is in APPROVAL_SURFACE_ALWAYS_ASK, so it is flagged either way;
    // a non-flagged tool typed by the user is still unflagged.
    expect(await predicate()(call('call'))).toMatch(/requires explicit approval/);
    expect(await predicate()(call('read_file'))).toBeNull();
  });
});
