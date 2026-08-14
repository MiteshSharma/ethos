import { matchWakePhrase, wakePhraseKey } from '@ethosagent/voice-text';
import type { rpc } from '../../rpc';

// Settings → Voice, wake-route manager: everything that is a decision rather
// than a rendering.
//
// Split out for the same reason `voiceChannelTtsOutFromConfig` is: the
// apps/web suite has no DOM, so the testable half has to be reachable without
// mounting a form. What lives here is the hydrate/serialize round trip, the id
// derivation, the mapping of a server rejection back onto the row that caused
// it, and the phrase tester's decision.
//
// The MATCHING ITSELF IS NOT HERE. `matchWakePhrase` comes from
// `@ethosagent/voice-text`, which is the same function the satellite's
// transcript wake engine calls. A second copy in the browser would drift, and
// the first symptom would be a tester that says a phrase works and a
// microphone that disagrees — in a room, where nobody can debug it.

type WakeRoutesData = Awaited<ReturnType<typeof rpc.voice.wakeRoutes.get>>;
export type WakeRouteWire = WakeRoutesData['routes'][number];
/** What `set` accepts — narrower than what `get` returns, because an implicit
 *  bare-name route is synthesized server-side and cannot be written back. */
export type WakeRouteInput = Parameters<typeof rpc.voice.wakeRoutes.set>[0]['routes'][number];
export type WakeSettings = WakeRoutesData['settings'];

/**
 * One row in the editor.
 *
 * `key` exists because `id` does not survive editing: the id is the yaml key,
 * derived from the phrase for rows the operator adds here, so it changes as
 * they type. React needs a handle that does not, and so does the tester, which
 * has to light up a row that has never been saved and therefore has no id yet.
 */
export interface WakeRouteDraft {
  key: string;
  /** The yaml key. Empty for a row that has not been saved yet. */
  id: string;
  phrase: string;
  personalityId: string;
  privileged: boolean;
  enabled: boolean;
}

/** DR1's exact copy. A route table with nothing in it still works — every
 *  personality answers to its own name — so the empty state says that rather
 *  than implying voice is switched off. It says the NAME, because that is the
 *  whole trigger: a greeting in front of it is allowed, not required. */
export const WAKE_ROUTES_EMPTY_COPY =
  'No wake routes yet — say a personality’s name to reach it. Add a custom phrase.';

export const SATELLITES_EMPTY_COPY =
  'No satellites connected. Run `ethos listen` on the machine with the microphone — a Pi, a spare laptop, or this one — and it appears here. `ethos listen doctor` checks the wake stack before you start.';

let keySeq = 0;
function nextKey(): string {
  keySeq += 1;
  return `wr-${keySeq}`;
}

/**
 * The editable rows in a server table — the CONFIGURED routes only.
 *
 * The read carries the effective table, which includes the implicit
 * bare-name route every unprivileged personality answers to. Those are not
 * drafts: they exist because a personality exists, they are not in
 * `config.yaml`, and hydrating them here would have the next save try to write
 * them into it. Filtered inside this function rather than at the call sites so
 * the two hydration points (first load, post-save) cannot disagree.
 */
export function wakeRouteDraftsFromServer(routes: readonly WakeRouteWire[]): WakeRouteDraft[] {
  return routes
    .filter((r) => !r.implicit)
    .map((r) => ({
      key: nextKey(),
      id: r.id,
      phrase: r.phrase,
      personalityId: r.personalityId,
      privileged: r.privileged,
      enabled: r.enabled,
    }));
}

/**
 * The other half of the same table: the bare-name routes the server
 * synthesized from the personality registry.
 *
 * Rendered read-only next to the editor rather than hidden, because "every
 * personality answers to its own name" is a claim the empty state makes and
 * this is the evidence for it — including which personalities are MISSING from
 * it, since a privileged one is deliberately not wake-reachable by default.
 *
 * Also half of what the tester matches against, via `wakeTestCandidates`.
 */
export function implicitWakeRoutes(routes: readonly WakeRouteWire[]): WakeRouteWire[] {
  return routes.filter((r) => r.implicit);
}

export function emptyWakeRouteDraft(): WakeRouteDraft {
  return {
    key: nextKey(),
    id: '',
    phrase: '',
    personalityId: '',
    privileged: false,
    enabled: true,
  };
}

/**
 * A yaml key for a phrase the operator just typed.
 *
 * Derived rather than asked for: the id is a config-file implementation
 * detail, and a form that demands one is a form that makes the user invent
 * something the machine can work out. Ids that already exist are left ALONE on
 * the way back out — an operator who hand-wrote `voice.wake.routes.engineer`
 * keeps that key when they edit the phrase, because rewriting somebody's yaml
 * keys behind their back is how a diff becomes unreviewable.
 */
export function deriveWakeRouteId(phrase: string, taken: ReadonlySet<string>): string {
  const base =
    phrase
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'route';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** What `voice.wakeRoutes.set` receives. Wholesale — a deleted route has to
 *  actually stop answering the door. */
export function wakeRoutesToInput(drafts: readonly WakeRouteDraft[]): WakeRouteInput[] {
  const taken = new Set(drafts.map((d) => d.id).filter((id) => id.length > 0));
  return drafts.map((d) => {
    const phrase = d.phrase.trim();
    let id = d.id;
    if (id.length === 0) {
      id = deriveWakeRouteId(phrase, taken);
      taken.add(id);
    }
    return {
      id,
      phrase,
      personalityId: d.personalityId,
      privileged: d.privileged,
      enabled: d.enabled,
    };
  });
}

/**
 * Client-side validation, keyed by row.
 *
 * Only the two failures the server cannot phrase better itself: an empty
 * phrase and an unpicked personality. Everything else — unknown personality,
 * duplicate id — is the server's judgement, and asking it is more honest than
 * mirroring its rules here.
 */
export function validateWakeRoutes(drafts: readonly WakeRouteDraft[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const d of drafts) {
    if (d.phrase.trim().length === 0) errors[d.key] = 'Say something — a route needs a phrase.';
    else if (d.personalityId.length === 0)
      errors[d.key] = 'Pick the personality this phrase wakes.';
  }
  return errors;
}

/**
 * Attribute a server rejection to the row that caused it.
 *
 * `WakeRoutesService` names the offending route id in quotes ("Wake route
 * "x" names unknown personality…", "Duplicate wake route id "x""). A toast
 * would carry the same sentence and lose the one thing that makes it
 * actionable in a ten-row table — which row. Falls back to null, and the
 * caller shows the message above the list, when no id in the message matches a
 * row we hold.
 */
export function wakeRouteErrorRow(
  message: string,
  drafts: readonly WakeRouteDraft[],
): { key: string; message: string } | null {
  const ids = new Map<string, string>();
  for (const d of drafts) if (d.id.length > 0) ids.set(d.id, d.key);
  // Rows added in this session have no id yet — match on the id the serializer
  // WOULD give them, which is the id the server just complained about.
  for (const wire of wakeRoutesToInput(drafts)) {
    const draft = drafts.find((d) => d.phrase.trim() === wire.phrase && d.id === '');
    if (draft) ids.set(wire.id, draft.key);
  }
  for (const quoted of message.matchAll(/"([^"]+)"/g)) {
    const key = ids.get(quoted[1] ?? '');
    if (key) return { key, message };
  }
  return null;
}

/**
 * One thing a spoken phrase can wake, as the tester sees it.
 *
 * `key` is the handle the panel lights up: a draft's `key` for a configured
 * row, and the wire id (`auto:<personalityId>`) for a synthesized one. Those
 * two namespaces cannot collide — a draft key is `wr-<n>` and `:` is outside
 * the charset a config id may use — so one `matchedKey` addresses both halves
 * of the table.
 */
export interface WakeCandidate {
  key: string;
  phrase: string;
  personalityId: string;
}

/**
 * The EFFECTIVE table the tester matches against: the editor's rows plus the
 * implicit bare-name routes.
 *
 * Matching drafts alone made the tester prove LESS than the system does —
 * "engineer" wakes the engineer in the room with no config at all, and the
 * tester lit nothing, which is the opposite of "the route is proven, not
 * assumed". This is a read-side union only; `wakeRouteDraftsFromServer` still
 * filters implicit rows out of the editor, so nothing here becomes saveable.
 *
 * The two suppression rules are `withImplicitWakeRoutes`' own, re-applied
 * against the UNSAVED table because that is the table being proven: a
 * personality a draft already routes loses its implicit route, and so does a
 * phrase a draft already claims. The server applies both when it assembles the
 * read, so they are redundant for a table nobody has touched — and they are
 * exactly what stops a half-typed row from lighting up next to the default it
 * is about to suppress. Both look at ALL drafts, disabled ones included: the
 * server suppresses on a disabled route too, on the grounds that switching a
 * personality's wake off did not ask for a fresh enabled default beside it.
 *
 * Drafts come FIRST so an identical phrase in both halves resolves to the
 * operator's row — `matchWakePhrase` keeps its incumbent on a tie.
 */
export function wakeTestCandidates(
  drafts: readonly WakeRouteDraft[],
  implicit: readonly WakeRouteWire[],
): WakeCandidate[] {
  const routed = new Set(drafts.map((d) => d.personalityId).filter((id) => id.length > 0));
  // Keyed on `wakePhraseKey` — the server's own rule. The greeting is optional
  // at match time, so a draft "hey engineer" and the default "engineer" are ONE
  // trigger, and a tester that lit both would be proving something the room
  // will not do.
  const claimed = new Set(drafts.map((d) => wakePhraseKey(d.phrase)).filter((p) => p.length > 0));
  return [
    ...drafts
      .filter((d) => d.enabled && d.phrase.trim().length > 0)
      .map((d) => ({ key: d.key, phrase: d.phrase.trim(), personalityId: d.personalityId })),
    ...implicit
      .filter((r) => !routed.has(r.personalityId) && !claimed.has(wakePhraseKey(r.phrase)))
      .map((r) => ({ key: r.id, phrase: r.phrase, personalityId: r.personalityId })),
  ];
}

/**
 * Which candidate a spoken phrase would wake, by key — the DR2 tester.
 *
 * Runs against the CURRENT, possibly unsaved, table: the point is to prove a
 * route before committing it. Disabled rows are skipped, exactly as the engine
 * skips them, so a switched-off route does not light up.
 */
export function wakeTestMatch(
  drafts: readonly WakeRouteDraft[],
  implicit: readonly WakeRouteWire[],
  transcript: string,
  sensitivity: number,
): string | null {
  const phrases = wakeTestCandidates(drafts, implicit).map((c) => ({
    id: c.key,
    phrase: c.phrase,
  }));
  return matchWakePhrase(phrases, transcript, sensitivity)?.id ?? null;
}
