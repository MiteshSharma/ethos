// Which surfaces may ANSWER a clarify — the other half of `./takeover-prompt`.
//
// That file's premise is that "a channel cannot answer a `browser_takeover`:
// the browser is open on the machine running Ethos and the hand-back button
// lives in the web chat". It only ever enforced that premise on the RENDERED
// TEXT. The answer path stayed wide open: a takeover row carries no `options`,
// and no options is the shape every text surface reads as "free-form", so a
// forced reply on Telegram, any group message on WhatsApp, and Discord's
// free-form Answer button each resolved a takeover with `source: 'user'` —
// which `browser_request_takeover` reports to the agent as `handed_back: true`.
// Anyone typing "ok" told the agent a login it is about to depend on had
// happened.
//
// The rule therefore lives HERE, in one predicate consulted by
// `ClarifyBridge.respond()` — the single funnel every answer from every
// surface passes through, in every process. A fifth adapter cannot forget it:
// it does not have to call anything for the refusal to hold, and a new
// `ClarifySurfaceType` is refused by default because the allowlist below is an
// enumeration of surfaces that can genuinely hand a browser back, not a
// denylist of ones that cannot.
//
// Surfaces call the same predicate too, but for a different reason: to avoid
// DRAWING an answer box the bridge would then refuse, and — on Telegram and
// WhatsApp, where a correlated message is swallowed before the normal pipeline
// — to let an unrelated message reach the agent instead of vanishing.

import type { ClarifyKind, ClarifySurfaceType } from '@ethosagent/types';

/**
 * Surfaces from which a `browser_takeover` may be handed back.
 *
 * `web` is the surface the takeover was designed around: authenticated, and
 * the only one with a Hand back control and a screencast of the page. `tui`
 * and `cli` run in the same process tree as the browser they would be handing
 * back — one operator, one keyboard, no bystanders — so a hand-back there is
 * by construction from the person who was just driving it.
 *
 * Every channel surface is absent, and absence is the point: a channel is
 * remote from the browser, is often a group, and shows the person answering
 * nothing about the page they are claiming to have dealt with.
 */
const TAKEOVER_HANDBACK_SURFACES: ReadonlySet<ClarifySurfaceType> = new Set<ClarifySurfaceType>([
  'web',
  'tui',
  'cli',
]);

/**
 * May a `source: 'user'` answer to this row be accepted on `surfaceType`?
 *
 * `true` for every ordinary question — including a row persisted before `kind`
 * existed, which reads as `question` — so this changes nothing outside a
 * takeover. `false` only for a `browser_takeover` on a surface that cannot
 * hand a browser back.
 *
 * Deliberately says nothing about `timeout-*` or `cancel`: a takeover nobody
 * can answer must still RESOLVE, or the browser session's takeover lock never
 * clears. Callers gate on `source === 'user'` before consulting this.
 */
export function isClarifyAnswerableOn(
  row: { kind?: ClarifyKind },
  surfaceType: ClarifySurfaceType,
): boolean {
  if ((row.kind ?? 'question') !== 'browser_takeover') return true;
  return TAKEOVER_HANDBACK_SURFACES.has(surfaceType);
}
