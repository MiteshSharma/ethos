// What `ClarifyBridge.respond()` DID with an answer.
//
// It used to return `Promise<void>` and answer that question with silence: an
// id it has no entry and no row for, a row whose answer gate refuses the
// surface it was asked on, and a row a peer process already answered all
// returned exactly like a resolution. Every surface that awaited it therefore
// reported success for an answer nobody received, and web-api grew a whole
// module (`clarify-resolution.ts`) that inferred the outcome from the OUTSIDE
// by testing object identity on an `onResolved` listener — an inference that
// was itself wrong for the already-answered case, because `respond()` notifies
// listeners with the caller's own response object even when first-writer-wins
// has just discarded it.
//
// So the outcome is reported from the inside, by the only code that knows it.
// The union has no value meaning "it worked" to fall through to: a caller that
// wants to claim a hand-back has to read `resolved`.
//
// Enforced by `ClarifyBridge.respond` in `./clarify-bridge`, which returns this
// type on every path, and pinned by
// `packages/core/src/__tests__/clarify-respond-outcome.test.ts`.

/** Why an answer did not land. Each is a distinguishable branch of `respond()`. */
export type ClarifyUnresolvedReason =
  /**
   * No in-process entry and no persisted row: already answered and collected,
   * cancelled, timed out and swept, or an id that never existed.
   */
  | 'unknown_request'
  /**
   * The row exists and is still open, but an `answer` was already on it when
   * this call read the row, so THIS answer was discarded and the agent gets
   * the one that was already there.
   *
   * Reported only when that earlier answer was VISIBLE at read time. Two calls
   * that both read an unanswered row before either writes miss this branch and
   * both report `{ resolved: true }` — see the LIMITATION note on
   * `ClarifyBridge.respond` in `./clarify-bridge`, which is where the guard
   * lives and where its window is named.
   */
  | 'already_answered'
  /**
   * The row exists, is still open, and carries no answer — but the answer gate
   * (`isClarifyAnswerableOn` in `./takeover-handback`) refuses it: a
   * `browser_takeover` asked on a surface that cannot hand a browser back. It
   * stays open until its timeout or a `cancel`.
   */
  | 'not_answerable';

/** The result of one `ClarifyBridge.respond()` call. */
export type ClarifyRespondOutcome =
  | { resolved: true }
  | { resolved: false; reason: ClarifyUnresolvedReason };

/**
 * One sentence per outcome, for the person who sent the answer.
 *
 * Separate sentences rather than one covering string because the causes are not
 * interchangeable: two of them mean the question is over and the third means it
 * is still open and the answering surface will never be the one to close it. A
 * single "already answered, cancelled, or timed out" line — which is what
 * web-api printed for all of them — is false for `not_answerable` in every
 * clause.
 *
 * NONE of them advises a retry, and that is a decision, not an omission.
 * `unknown_request` and `already_answered` mean there is no longer a question.
 * `not_answerable` leaves the row open, but the gate keys on the ROW's surface
 * (`isClarifyAnswerableOn(row, row.surfaceType)` in `ClarifyBridge.respond`),
 * so the same surface asking twice is refused identically. The takeover
 * socket's own `handback_failed` copy DOES invite a retry; it can, because it
 * asks `stillBound` first and its lane exists only for a row the web presented
 * (`apps/web-api/src/browser/takeover-socket.ts`, `refuse`).
 *
 * Where these sentences surface, as of this writing: `clarify.respond`
 * (`apps/web-api/src/rpc/clarify.ts`) throws them, and they are rendered by
 * `ClarifyCard`'s `respond` and `TakeoverCard`'s `handBack` (into
 * `submitError`, `apps/web/src/components/chat/ClarifyCard.tsx`) and by
 * `TakeoverMode.handBack` (into `handbackNotice`,
 * `apps/web/src/components/browser/TakeoverMode.tsx`). The voice path in
 * `apps/web/src/pages/Chat.tsx` does NOT render them — `runVoiceClarify` is
 * handed a `.then(() => undefined)` with no catch, so a refusal there is an
 * unhandled rejection nobody hears. A known gap, written down rather than
 * asserted away.
 */
export function clarifyUnresolvedMessage(reason: ClarifyUnresolvedReason): string {
  switch (reason) {
    case 'unknown_request':
      return 'that request is no longer open — it was already answered, cancelled, or timed out';
    case 'already_answered':
      return 'that request was already answered somewhere else, and the first answer is the one the agent received';
    case 'not_answerable':
      return 'that request is a browser hand-back, and the surface it was asked on cannot hand a browser back — it is still open, and ends only when it times out or is cancelled';
  }
}
