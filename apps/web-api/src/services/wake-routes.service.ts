import { EthosError } from '@ethosagent/types';
import {
  WAKE_SETTINGS_DEFAULTS,
  type WakeRoute,
  type WakeSettings,
} from '../repositories/config.repository';
import type { SatelliteRegistry } from '../voice/satellite-registry';
import type { ConfigService } from './config.service';
import type { PersonalitiesService } from './personalities.service';

// The wake-route editor's read/write half.
//
// Separate from `SatelliteRegistry` on purpose: the registry is the LIVE view —
// which microphones are connected and what table they were last pushed — and it
// must not know how to write `config.yaml`. This is the other direction: it
// validates an operator's edit, writes it through the one config writer, and
// lets `ConfigService`'s own update seam do the push. Nothing here talks to a
// socket.

export interface WakeRoutesServiceOptions {
  config: ConfigService;
  /** Validates the personality a route names. */
  personalities: PersonalitiesService;
  /**
   * The live registry, which caches the parsed table. Absent in deployments
   * with no satellite lane — the editor then reports an empty house rather
   * than throwing at a Settings page that legitimately has nothing to show.
   */
  registry?: SatelliteRegistry;
}

export interface WakeRoutesView {
  routes: WakeRoute[];
  settings: WakeSettings;
}

/**
 * What the editor may WRITE — a configured route, no `implicit` flag.
 *
 * Implicit `hey <name>` routes are read-only by construction: they are
 * synthesized from the personality registry, never stored, and their `auto:`
 * ids fail `ConfigService`'s identifier check anyway. Taking a type that cannot
 * express one is how a save round trip stops being able to materialize them.
 */
export type WakeRouteInput = Omit<WakeRoute, 'implicit'>;

/** What a deployment with no satellite lane reports — the parser's own
 *  defaults, from the same constant, so the editor renders the same numbers
 *  either way. */
const EMPTY_VIEW: WakeRoutesView = { routes: [], settings: WAKE_SETTINGS_DEFAULTS };

export class WakeRoutesService {
  constructor(private readonly opts: WakeRoutesServiceOptions) {}

  async get(): Promise<WakeRoutesView> {
    const registry = this.opts.registry;
    if (!registry) return EMPTY_VIEW;
    const table = await registry.table();
    return { routes: table.routes, settings: table.settings };
  }

  /**
   * Replace the whole route table.
   *
   * Validation is the point of doing this here rather than in the handler: a
   * route naming a personality that does not exist fails SILENTLY in a room —
   * somebody says the phrase and nothing happens — and the editor is the last
   * place the operator can still see the typo.
   */
  async set(routes: WakeRouteInput[]): Promise<WakeRoutesView> {
    const seen = new Set<string>();
    for (const route of routes) {
      if (seen.has(route.id)) {
        throw new EthosError({
          code: 'CONFIG_INVALID',
          cause: `Duplicate wake route id "${route.id}".`,
          action: 'Give each route a unique id.',
        });
      }
      seen.add(route.id);
      if (!(await this.opts.personalities.exists(route.personalityId))) {
        throw new EthosError({
          code: 'CONFIG_INVALID',
          cause: `Wake route "${route.id}" names unknown personality "${route.personalityId}".`,
          action: 'Pick an existing personality, or create it first.',
        });
      }
    }
    await this.opts.config.update({
      wakeRoutes: Object.fromEntries(
        routes.map((r) => [
          r.id,
          {
            phrase: r.phrase,
            personality: r.personalityId,
            privileged: r.privileged,
            enabled: r.enabled,
          },
        ]),
      ),
    });
    // `ConfigService.update` already awaited the push seam, so the registry's
    // cached table is the freshly written one. Re-read rather than echo the
    // input: what the file says is the answer, including anything the writer
    // normalised on the way through.
    return this.get();
  }
}
