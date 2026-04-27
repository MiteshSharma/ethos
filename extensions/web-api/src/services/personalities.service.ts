import { EthosError } from '@ethosagent/types';
import type { Personality } from '@ethosagent/web-contracts';
import type { PersonalityRepository, DescribedPersonality } from '../repositories/personality.repository';

// Read-only personalities surface for v0. Returns the wire-shape `Personality`
// (server-internal `ethosFile`/`skillsDirs` paths stripped — those would
// leak server filesystem layout to the browser).
//
// Create / edit / per-personality skills land in 26.4b (Phase 26 v1 stage).

export interface PersonalitiesServiceOptions {
  personalities: PersonalityRepository;
}

export class PersonalitiesService {
  constructor(private readonly opts: PersonalitiesServiceOptions) {}

  list(): { personalities: Personality[]; defaultId: string } {
    return {
      personalities: this.opts.personalities.list().map(toWire),
      defaultId: this.opts.personalities.defaultId(),
    };
  }

  async get(id: string): Promise<{ personality: Personality; ethosMd: string }> {
    const described = this.opts.personalities.get(id);
    if (!described) {
      throw new EthosError({
        code: 'PERSONALITY_NOT_FOUND',
        cause: `Personality "${id}" not found`,
        action: 'Call `personalities.list` to see available IDs.',
      });
    }
    const ethosMd = await this.opts.personalities.readEthosMd(id);
    return { personality: toWire(described), ethosMd };
  }
}

function toWire(d: DescribedPersonality): Personality {
  const c = d.config;
  return {
    id: c.id,
    name: c.name,
    description: c.description ?? null,
    model: c.model ?? null,
    provider: c.provider ?? null,
    toolset: c.toolset ?? null,
    capabilities: c.capabilities ?? null,
    memoryScope: c.memoryScope ?? null,
    streamingTimeoutMs: c.streamingTimeoutMs ?? null,
    builtin: d.builtin,
  };
}
