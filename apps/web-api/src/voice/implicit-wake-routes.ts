import type { PersonalityConfig } from '@ethosagent/types';
import type { WakeRoute, WakeRoutingTable } from '../repositories/config.repository';
import { isPrivilegedPersonality } from './wake-privilege';

// "hey <name>" — the default trigger every personality answers to.
//
// This is the plan's headline behaviour, and it is SYNTHESIZED rather than
// written to `config.yaml`: a deployment that has configured nothing can still
// wake its personalities by name, and adding a personality gives it a voice
// without also editing a routing table. Materializing these into the file would
// mean a config diff on every personality create, and an operator's deletion of
// one line silently un-naming an agent.
//
// SERVER-SIDE, in the one place the table is assembled (the `readTable` seam
// `SatelliteRegistry` reads through) — so the satellite's pushed `routes` frame,
// the lane's own wake re-resolution, and the Settings editor all see exactly the
// same effective table. A satellite that synthesized its own defaults would be a
// second opinion about what the house answers to.

/**
 * Prefix for a synthesized route's id.
 *
 * COLLISION-PROOF, not merely unlikely: a config route id is validated against
 * `/^[A-Za-z0-9_-]+$/` (both in `ConfigService`'s write validation and the
 * `voice.wakeRoutes.set` contract), and `:` is not in that charset. No id an
 * operator can write can ever start with `auto:`, so an implicit route cannot
 * shadow — or be shadowed by — one from the file.
 */
export const IMPLICIT_ROUTE_ID_PREFIX = 'auto:';

/** The default trigger for a display name. Lowercased, internal runs of
 *  whitespace collapsed, so "Swing  Trader" and "swing trader" are one phrase. */
export function implicitWakePhrase(name: string): string {
  return `hey ${name.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

/**
 * The configured table plus one `hey <name>` route per reachable personality.
 *
 * Rules, in the order they are applied:
 *
 * 1. **Privileged personalities get nothing** (eng-review D13). The default wake
 *    surface exposes only unprivileged personalities; a privileged one is
 *    reachable by voice solely through a route that opts in out loud. Privilege
 *    is decided by `isPrivilegedPersonality` — the one definition, not a second
 *    opinion.
 * 2. **A config route wins for its personality.** Any route in the file naming a
 *    personality suppresses that personality's implicit route, including a
 *    DISABLED one: an operator who switched a personality's wake off did not ask
 *    for a fresh enabled route to appear beside it.
 * 3. **A phrase is claimed once.** If the file already answers to "hey engineer"
 *    — even pointing somewhere else — no implicit route duplicates it. Two
 *    routes with one phrase would make `SatelliteLane`'s phrase lookup an
 *    arbitrary choice.
 * 4. **Ties break by personality id, ascending.** Two personalities whose names
 *    lowercase to the same string are a real possibility ("Engineer" and
 *    "engineer"); the first by sorted id takes the phrase and the other gets no
 *    implicit route. Deterministic, so the same house answers the same way after
 *    a restart.
 *
 * Implicit routes are appended AFTER the configured ones, so a phrase lookup
 * scanning in order reaches the operator's routes first.
 */
export function withImplicitWakeRoutes(
  table: WakeRoutingTable,
  personalities: readonly PersonalityConfig[],
): WakeRoutingTable {
  const routedPersonalities = new Set(table.routes.map((r) => r.personalityId));
  const claimedPhrases = new Set(table.routes.map((r) => r.phrase.trim().toLowerCase()));
  const implicit: WakeRoute[] = [];

  for (const personality of [...personalities].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (routedPersonalities.has(personality.id)) continue;
    if (isPrivilegedPersonality(personality)) continue;
    if (personality.name.trim().length === 0) continue;
    const phrase = implicitWakePhrase(personality.name);
    if (claimedPhrases.has(phrase)) continue;
    claimedPhrases.add(phrase);
    implicit.push({
      id: `${IMPLICIT_ROUTE_ID_PREFIX}${personality.id}`,
      phrase,
      personalityId: personality.id,
      privileged: false,
      enabled: true,
      implicit: true,
    });
  }

  if (implicit.length === 0) return table;
  return { ...table, routes: [...table.routes, ...implicit] };
}
