import type { PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  WAKE_SETTINGS_DEFAULTS,
  type WakeRoute,
  type WakeRoutingTable,
} from '../../repositories/config.repository';
import { IMPLICIT_ROUTE_ID_PREFIX, withImplicitWakeRoutes } from '../implicit-wake-routes';

// The BARE NAME — the plan's headline behaviour. What is pinned here is that a
// deployment which has configured NOTHING can still wake its personalities by
// name, and that the one thing this default must never do is hand an
// unauthenticated voice in the room a privileged agent.
//
// The phrase is the name alone because "hey" was the half that failed in a real
// room. It is not a narrowing: `matchWakePhrase` treats a leading greeting as
// optional on both sides, so "hey researcher" reaches a `researcher` route and
// always will — the cases for that live in packages/voice-text.

/** Unprivileged by default: a read-only toolset reaches no consequential tool. */
function p(id: string, name: string, toolset: string[] = ['read_file', 'web_search']) {
  return { id, name, toolset } satisfies PersonalityConfig;
}

function table(routes: WakeRoute[] = []): WakeRoutingTable {
  return { routes, nodes: {}, settings: WAKE_SETTINGS_DEFAULTS };
}

function route(over: Partial<WakeRoute> = {}): WakeRoute {
  return {
    id: 'r',
    phrase: 'hey there',
    personalityId: 'engineer',
    privileged: false,
    enabled: true,
    implicit: false,
    ...over,
  };
}

describe('withImplicitWakeRoutes', () => {
  it('makes an unprivileged personality wake-reachable with no config at all', () => {
    const merged = withImplicitWakeRoutes(table(), [p('engineer', 'Engineer')]);
    expect(merged.routes).toEqual([
      {
        id: 'auto:engineer',
        phrase: 'engineer',
        personalityId: 'engineer',
        privileged: false,
        enabled: true,
        implicit: true,
      },
    ]);
  });

  it('leaves a privileged personality off the default wake surface (eng-review D13)', () => {
    const merged = withImplicitWakeRoutes(table(), [
      p('engineer', 'Engineer'),
      p('operator', 'Operator', ['read_file', 'terminal']),
      // An absent toolset means every registered tool — privileged, fail-closed.
      { id: 'root', name: 'Root' },
    ]);
    expect(merged.routes.map((r) => r.personalityId)).toEqual(['engineer']);
  });

  it('lets an explicit route win for the same personality', () => {
    const merged = withImplicitWakeRoutes(
      table([route({ id: 'eng', phrase: 'yo eng', personalityId: 'engineer' })]),
      [p('engineer', 'Engineer')],
    );
    expect(merged.routes).toEqual([
      route({ id: 'eng', phrase: 'yo eng', personalityId: 'engineer' }),
    ]);
  });

  it('keeps a DISABLED explicit route decisive — an off switch is not an invitation', () => {
    const merged = withImplicitWakeRoutes(
      table([route({ id: 'eng', personalityId: 'engineer', enabled: false })]),
      [p('engineer', 'Engineer')],
    );
    expect(merged.routes.map((r) => r.id)).toEqual(['eng']);
  });

  it('is additive for a personality the explicit routes do not name', () => {
    const merged = withImplicitWakeRoutes(
      table([route({ id: 'eng', phrase: 'yo eng', personalityId: 'engineer' })]),
      [p('engineer', 'Engineer'), p('researcher', 'Researcher')],
    );
    expect(merged.routes.map((r) => r.id)).toEqual(['eng', 'auto:researcher']);
  });

  it('does not duplicate a phrase the config already claims', () => {
    // The file answers to "hey engineer" but sends it somewhere else. A second
    // route with the same phrase would make the lane's lookup a coin toss —
    // and "hey engineer" and "engineer" ARE the same phrase to the matcher, so
    // the claim is compared on the greeting-stripped key.
    const merged = withImplicitWakeRoutes(
      table([route({ id: 'decoy', phrase: 'Hey Engineer', personalityId: 'researcher' })]),
      [p('engineer', 'Engineer')],
    );
    expect(merged.routes.map((r) => r.id)).toEqual(['decoy']);
  });

  it('claims across the greeting in the other direction too', () => {
    // A config route spelled without the greeting suppresses the default just
    // as one spelled with it does. Either way the room has one answer.
    const merged = withImplicitWakeRoutes(
      table([route({ id: 'decoy', phrase: 'engineer', personalityId: 'researcher' })]),
      [p('engineer', 'Engineer')],
    );
    expect(merged.routes.map((r) => r.id)).toEqual(['decoy']);
  });

  it('skips a name that normalises to nothing rather than minting an empty trigger', () => {
    // A phrase with no letters or digits in it cannot be said, and two such
    // names would claim the same empty key.
    const merged = withImplicitWakeRoutes(table(), [p('punct', '!!!'), p('real', 'Coach')]);
    expect(merged.routes.map((r) => r.phrase)).toEqual(['coach']);
  });

  it('breaks a lowercased-name tie by personality id, ascending', () => {
    const merged = withImplicitWakeRoutes(table(), [
      p('zeta', 'Engineer'),
      p('alpha', 'engineer'),
      p('mid', 'ENGINEER'),
    ]);
    expect(merged.routes).toHaveLength(1);
    expect(merged.routes[0]?.personalityId).toBe('alpha');
  });

  it('mints ids no config key can collide with', () => {
    // Config ids are validated `/^[A-Za-z0-9_-]+$/` in both the write path and
    // the RPC contract, so a `:` in the prefix is what makes this proof rather
    // than probability.
    expect(IMPLICIT_ROUTE_ID_PREFIX).toContain(':');
    const merged = withImplicitWakeRoutes(table(), [p('engineer', 'Engineer')]);
    for (const r of merged.routes.filter((x) => x.implicit)) {
      expect(r.id.startsWith(IMPLICIT_ROUTE_ID_PREFIX)).toBe(true);
      expect(/^[A-Za-z0-9_-]+$/.test(r.id)).toBe(false);
    }
  });

  it('skips a personality with a blank name and normalises inner whitespace', () => {
    const merged = withImplicitWakeRoutes(table(), [
      p('blank', '   '),
      p('trader', '  Swing   Trader '),
    ]);
    expect(merged.routes.map((r) => r.phrase)).toEqual(['swing trader']);
  });

  it('returns the same table object when there is nothing to add', () => {
    const original = table([route()]);
    expect(withImplicitWakeRoutes(original, [])).toBe(original);
  });
});
