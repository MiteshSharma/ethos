import type { ClarifyBridge } from '@ethosagent/core';
import type { ClarifyResponse } from '@ethosagent/types';

// Did the answer this process just sent actually resolve the clarify?
//
// `ClarifyBridge.respond()` returns `Promise<void>` and answers that question
// with silence. It swallows — deliberately, and documented as such — every
// request it cannot resolve: an id it has no in-process entry for and no row on
// disk for (already settled, expired, or cancelled), and, since the takeover
// answer gate landed, a `browser_takeover` row whose surface may not hand a
// browser back. A caller awaiting it therefore cannot tell "answered" from
// "there was nothing to answer", and both of web-api's answer paths — the
// takeover socket's `handback` frame and `clarify.respond` — were reporting
// success for both.
//
// That is the fourth time this feature has reported a hand-back nothing
// performed, so this is not a fourth guard in a fourth caller. It is the ONE
// place either path gets an answer from, and the shape it returns has no
// "it worked" value to fall through to.
//
// THE EVIDENCE, and why it is exactly this: `respond()` calls `notifyResolved`
// on precisely the paths that resolved something, and passes through the SAME
// response object it was handed. So the listener below fires for this call and
// no other — not for a peer surface answering the same row inside our await,
// not for a timeout sweep, not for a cancel. Object identity is the whole of
// it; nothing here inspects the row or re-reads the store.
//
// WHAT WOULD REPLACE THIS: `respond()` reporting its own outcome — the three
// `return`s in `packages/core/src/clarify/clarify-bridge.ts:489-505` are the
// three failures, and they are already distinguished there by reasons this
// file has to infer from the outside. That is a `packages/core` change; until
// it lands, every web-api answer path goes through here rather than through
// `bridge.respond` directly.

/** Why an answer did not land, in a sentence meant for the person who sent it. */
export const CLARIFY_UNRESOLVED_REASON =
  'that request is no longer open — it was already answered, cancelled, or timed out';

/**
 * Send one answer through the bridge and report whether it resolved the row.
 *
 * `false` is not an error: a question answered in another tab a moment earlier
 * is ordinary. It is the CALLER's job to decide what that means — the takeover
 * lane refuses the hand-back and keeps the browser with the human; the RPC
 * tells the browser its answer did not land.
 */
export async function respondAndConfirm(
  bridge: ClarifyBridge,
  response: ClarifyResponse,
): Promise<boolean> {
  let resolved = false;
  const off = bridge.onResolved((_row, delivered) => {
    // Identity, not `requestId`: this must be OUR resolution, not somebody
    // else's landing on the same row while we were awaiting.
    if (delivered === response) resolved = true;
  });
  try {
    await bridge.respond(response);
  } finally {
    off();
  }
  return resolved;
}
