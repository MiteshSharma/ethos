import type {
  CreatePersonalityInput,
  DescribedPersonality,
  FilePersonalityRegistry,
  UpdatePersonalityPatch,
} from '@ethosagent/personalities';
import type { PersonalitySkillRecord, SkillsLibrary } from '@ethosagent/skills';
import { EthosError } from '@ethosagent/types';
import type { Personality, PersonalitySkill } from '@ethosagent/web-contracts';

// Personalities service. Calls into FilePersonalityRegistry for the
// directory-level CRUD (create/update/delete/duplicate) and into
// SkillsLibrary for the per-personality skills/ subdir. Both extensions
// own their own Storage layer; the service is a thin wire-shape mapper.

export interface PersonalitiesServiceOptions {
  personalities: FilePersonalityRegistry;
  library: SkillsLibrary;
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
  // Per-personality skills (gate 19)
  // ---------------------------------------------------------------------------

  async skillsList(personalityId: string): Promise<{ skills: PersonalitySkill[] }> {
    this.requirePersonality(personalityId);
    const records = await this.opts.library.listPersonalitySkills(personalityId);
    return { skills: records.map(toWirePersonalitySkill) };
  }

  async skillsGet(personalityId: string, skillId: string): Promise<{ skill: PersonalitySkill }> {
    this.requirePersonality(personalityId);
    const skill = await this.opts.library.getPersonalitySkill(personalityId, skillId);
    if (!skill) {
      throw new EthosError({
        code: 'SKILL_NOT_FOUND',
        cause: `Skill "${skillId}" not found for personality "${personalityId}".`,
        action: 'Use personalities.skillsList to see installed skills.',
      });
    }
    return { skill: toWirePersonalitySkill(skill) };
  }

  async skillsCreate(
    personalityId: string,
    skillId: string,
    body: string,
  ): Promise<{ skill: PersonalitySkill }> {
    this.requirePersonality(personalityId);
    const skill = await this.opts.library.createPersonalitySkill(personalityId, skillId, body);
    return { skill: toWirePersonalitySkill(skill) };
  }

  async skillsUpdate(
    personalityId: string,
    skillId: string,
    body: string,
  ): Promise<{ skill: PersonalitySkill }> {
    this.requirePersonality(personalityId);
    const skill = await this.opts.library.updatePersonalitySkill(personalityId, skillId, body);
    return { skill: toWirePersonalitySkill(skill) };
  }

  async skillsDelete(personalityId: string, skillId: string): Promise<void> {
    this.requirePersonality(personalityId);
    await this.opts.library.deletePersonalitySkill(personalityId, skillId);
  }

  async skillsImportGlobal(
    personalityId: string,
    skillIds: string[],
  ): Promise<{ imported: PersonalitySkill[] }> {
    this.requirePersonality(personalityId);
    const records = await this.opts.library.importGlobalIntoPersonality(personalityId, skillIds);
    return { imported: records.map(toWirePersonalitySkill) };
  }

  private requirePersonality(id: string): void {
    if (!this.opts.personalities.describe(id)) {
      throw new EthosError({
        code: 'PERSONALITY_NOT_FOUND',
        cause: `Personality "${id}" not found.`,
        action: 'Use personalities.list to see available ids.',
      });
    }
  }
}

function toWirePersonalitySkill(record: PersonalitySkillRecord): PersonalitySkill {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    body: record.body,
    modifiedAt: record.modifiedAt,
  };
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
    mcp_servers: c.mcp_servers ?? null,
    plugins: c.plugins ?? null,
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
