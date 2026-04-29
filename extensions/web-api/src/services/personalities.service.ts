import type {
  CreatePersonalityInput,
  DescribedPersonality,
  FilePersonalityRegistry,
  UpdatePersonalityPatch,
} from '@ethosagent/personalities';
import { EthosError } from '@ethosagent/types';
import type { Personality, PersonalitySkill } from '@ethosagent/web-contracts';
import type { PersonalitySkillsRepository } from '../repositories/personality-skills.repository';

// Personalities service. Calls into FilePersonalityRegistry directly for
// the directory-level CRUD (create/update/delete/duplicate). The registry
// owns the mtime cache + on-disk format, so the service is a thin
// wire-shape mapper.
//
// The skills sub-surface still leans on PersonalitySkillsRepository for
// now — that lands in the next batch.

export interface PersonalitiesServiceOptions {
  personalities: FilePersonalityRegistry;
  personalitySkills: PersonalitySkillsRepository;
}

export class PersonalitiesService {
  constructor(private readonly opts: PersonalitiesServiceOptions) {}

  list(): { personalities: Personality[]; defaultId: string } {
    return {
      personalities: this.opts.personalities.describeAll().map(toWire),
      defaultId: this.opts.personalities.getDefault().id,
    };
  }

  async get(id: string): Promise<{ personality: Personality; ethosMd: string }> {
    const described = this.opts.personalities.describe(id);
    if (!described) throw notFound(id);
    const ethosMd = await this.opts.personalities.readEthosMd(id);
    return { personality: toWire(described), ethosMd };
  }

  async create(input: CreatePersonalityInput): Promise<{ personality: Personality }> {
    const created = await this.opts.personalities.create(input);
    return { personality: toWire(created) };
  }

  async update(id: string, patch: UpdatePersonalityPatch): Promise<{ personality: Personality }> {
    const updated = await this.opts.personalities.update(id, patch);
    return { personality: toWire(updated) };
  }

  async delete(id: string): Promise<void> {
    await this.opts.personalities.deletePersonality(id);
  }

  async duplicate(id: string, newId: string): Promise<{ personality: Personality }> {
    const created = await this.opts.personalities.duplicate(id, newId);
    return { personality: toWire(created) };
  }

  // ---------------------------------------------------------------------------
  // Per-personality skills (gate 19) — TODO: collapse the repo
  // ---------------------------------------------------------------------------

  async skillsList(personalityId: string): Promise<{ skills: PersonalitySkill[] }> {
    return { skills: await this.opts.personalitySkills.list(personalityId) };
  }

  async skillsGet(personalityId: string, skillId: string): Promise<{ skill: PersonalitySkill }> {
    const skill = await this.opts.personalitySkills.get(personalityId, skillId);
    if (!skill) {
      throw new EthosError({
        code: 'SKILL_NOT_FOUND',
        cause: `Skill "${skillId}" not found for personality "${personalityId}".`,
        action: 'Use personalities.skillsList to see installed skills.',
      });
    }
    return { skill };
  }

  async skillsCreate(
    personalityId: string,
    skillId: string,
    body: string,
  ): Promise<{ skill: PersonalitySkill }> {
    return { skill: await this.opts.personalitySkills.create(personalityId, skillId, body) };
  }

  async skillsUpdate(
    personalityId: string,
    skillId: string,
    body: string,
  ): Promise<{ skill: PersonalitySkill }> {
    return { skill: await this.opts.personalitySkills.update(personalityId, skillId, body) };
  }

  async skillsDelete(personalityId: string, skillId: string): Promise<void> {
    await this.opts.personalitySkills.delete(personalityId, skillId);
  }

  async skillsImportGlobal(
    personalityId: string,
    skillIds: string[],
  ): Promise<{ imported: PersonalitySkill[] }> {
    return {
      imported: await this.opts.personalitySkills.importFromGlobal(personalityId, skillIds),
    };
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

function notFound(id: string): EthosError {
  return new EthosError({
    code: 'PERSONALITY_NOT_FOUND',
    cause: `Personality "${id}" not found`,
    action: 'Call `personalities.list` to see available IDs.',
  });
}
