// Spoken-confirmation gate (voice V1a §4, eng-review D13).
//
// Two rules, and the second is the one that matters:
//
//  1. A high-impact call the user asked for OUT LOUD needs a verbal
//     re-confirmation before it runs. Speech is lossy — a mis-heard word, a
//     half-sentence caught by the endpointer, a TV in the room — and the
//     recovery for a mis-heard "delete" is not the same as for a mis-typed one.
//
//  2. **A far-end caller's voice can NEVER satisfy an owner-level
//     confirmation.** Whoever is on the other end of a phone call is not the
//     operator, cannot become the operator by sounding confident, and cannot
//     be made the operator by any confirmation this process recorded. Their
//     request routes to the owner's own channel through the approval surface,
//     and the gate refuses BEFORE it looks at any recorded confirmation — so
//     there is no ordering in which a caller talks their way past it.
//
// This ships now, ahead of telephony (V4), on purpose: a gate that arrives
// with the capability it gates has already been wrong once. Today nothing
// constructs a `far_end` origin, so rule 2 is enforced against a speaker the
// repo cannot yet produce — which is exactly when it is cheap to get right.
//
// It decorates the danger predicate rather than replacing it. The base
// predicate is the FLOOR: a reason it returns is returned unchanged, and this
// gate can only ever add reasons. Modes make things stricter, never looser
// (see `./danger-predicate`).

import type { DangerPredicate } from './danger-predicate';
import { APPROVAL_SURFACE_ALWAYS_ASK, SMART_MODE_CONSEQUENTIAL_TOOLS } from './danger-predicate';

/**
 * Tools a SPOKEN request must re-confirm out loud.
 *
 * Derived rather than hand-listed: it is exactly the union of the tools every
 * approval surface already always asks about and the tools smart mode treats
 * as consequential. A tool that is consequential when typed does not become
 * less consequential when spoken, and deriving it means a future entry in
 * either list is covered here without anyone remembering to copy it.
 */
export const SPOKEN_CONFIRMATION_TOOLS: ReadonlyArray<string> = [
  ...new Set([...APPROVAL_SURFACE_ALWAYS_ASK, ...SMART_MODE_CONSEQUENTIAL_TOOLS]),
];

/**
 * Record of verbal re-confirmations already given on an OWNER-trusted surface,
 * keyed by `toolCallId`. Injected because nothing in-repo produces one yet:
 * the browser call strip and V4's call path are the intended writers. Absent →
 * nothing is ever pre-confirmed, which is the safe direction to default.
 */
export interface SpokenConfirmationRecord {
  has(toolCallId: string): boolean;
}

export interface SpokenConfirmationOptions {
  /** Override the gated tool set. Defaults to {@link SPOKEN_CONFIRMATION_TOOLS}. */
  tools?: ReadonlyArray<string>;
  /** See {@link SpokenConfirmationRecord}. */
  confirmations?: SpokenConfirmationRecord;
}

/** Reason text for a far-end request. Exported so surfaces can match on it. */
export function farEndRefusalReason(toolName: string): string {
  return (
    `${toolName} was requested by a far-end caller — a caller's voice cannot authorize ` +
    "this. Confirm on the owner's own channel."
  );
}

/** Reason text for an owner's own unconfirmed spoken request. */
export function spokenConfirmationReason(toolName: string): string {
  return `${toolName} was requested out loud — confirm it verbally before it runs`;
}

/**
 * Wrap a danger predicate with the spoken-confirmation gate.
 *
 * Inert for typed turns: no `voiceOrigin` on the payload → the base predicate's
 * answer is returned untouched.
 */
export function withSpokenConfirmation(
  base: DangerPredicate,
  opts: SpokenConfirmationOptions = {},
): DangerPredicate {
  const gated = new Set(opts.tools ?? SPOKEN_CONFIRMATION_TOOLS);
  const confirmations = opts.confirmations;
  return async (payload) => {
    // The base predicate is the floor — its reason wins, and a reason it
    // already returned is not made weaker here.
    const baseReason = await base(payload);
    if (baseReason) return baseReason;

    const origin = payload.voiceOrigin;
    if (!origin) return null;
    if (!gated.has(payload.toolName)) return null;

    // Rule 2, checked FIRST and with no escape: a recorded confirmation is not
    // even consulted for a far-end speaker. Ordering is the enforcement.
    if (origin.speaker === 'far_end') return farEndRefusalReason(payload.toolName);

    if (confirmations?.has(payload.toolCallId)) return null;
    return spokenConfirmationReason(payload.toolName);
  };
}
