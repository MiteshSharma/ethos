import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { EthosError, type Storage } from '@ethosagent/types';
import { parseSkillFrontmatter } from './skill-compat';

// CRUD over the markdown-skill files under ~/.ethos/skills/ (global) and
// ~/.ethos/personalities/<id>/skills/ (per-personality). Sits alongside
// the SkillsInjector which only reads these files into prompts; this
// class is what the web Skills tab uses to add / edit / delete them.
//
// File format: a single `.md` file with optional YAML frontmatter. The
// id is the filename stem (e.g. `tighten-prose.md` → id `tighten-prose`).

export interface SkillRecord {
  id: string;
  name: string;
  description: string | null;
  frontmatter: Record<string, unknown>;
  body: string;
  modifiedAt: string;
}

export interface PersonalitySkillRecord {
  id: string;
  name: string;
  description: string | null;
  body: string;
  modifiedAt: string;
}

export interface PendingSkillRecord {
  id: string;
  name: string;
  description: string | null;
  body: string;
  proposedAt: string;
}

export interface SkillsLibraryOptions {
  /** Root data dir — `~/.ethos/`. */
  dataDir: string;
  /** Storage backend. Defaults to FsStorage. */
  storage?: Storage;
}

export class SkillsLibrary {
  private readonly storage: Storage;
  private readonly skillsDir: string;
  private readonly pendingDir: string;
  private readonly personalitiesDir: string;

  constructor(opts: SkillsLibraryOptions) {
    this.storage = opts.storage ?? new FsStorage();
    this.skillsDir = join(opts.dataDir, 'skills');
    this.pendingDir = join(this.skillsDir, '.pending');
    this.personalitiesDir = join(opts.dataDir, 'personalities');
  }

  /** Absolute path to the directory holding live (global) skills. */
  getSkillsDir(): string {
    return this.skillsDir;
  }

  /** Absolute path to the pending-candidates directory. */
  getPendingDir(): string {
    return this.pendingDir;
  }

  // ---------------------------------------------------------------------------
  // Global skills
  // ---------------------------------------------------------------------------

  async listSkills(): Promise<SkillRecord[]> {
    const names = await this.storage.list(this.skillsDir);
    const out: SkillRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const skill = await this.readGlobal(name);
      if (skill) out.push(skill);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  async getSkill(id: string): Promise<SkillRecord | null> {
    return this.readGlobal(`${id}.md`);
  }

  async createSkill(id: string, body: string): Promise<SkillRecord> {
    await this.storage.mkdir(this.skillsDir);
    const path = join(this.skillsDir, `${id}.md`);
    if (await this.storage.exists(path)) {
      throw new EthosError({
        code: 'SKILL_EXISTS',
        cause: `A skill named "${id}" already exists.`,
        action: 'Pick a different id or open the existing skill to edit it.',
      });
    }
    await this.storage.write(path, ensureTrailingNewline(body));
    const created = await this.readGlobal(`${id}.md`);
    if (!created) throw new Error(`createSkill: failed to read back ${id}`);
    return created;
  }

  async updateSkill(id: string, body: string): Promise<SkillRecord> {
    const path = join(this.skillsDir, `${id}.md`);
    if (!(await this.storage.exists(path))) throw notFoundGlobal(id);
    await this.storage.write(path, ensureTrailingNewline(body));
    const updated = await this.readGlobal(`${id}.md`);
    if (!updated) throw new Error(`updateSkill: failed to read back ${id}`);
    return updated;
  }

  async deleteSkill(id: string): Promise<void> {
    const path = join(this.skillsDir, `${id}.md`);
    if (!(await this.storage.exists(path))) throw notFoundGlobal(id);
    await this.storage.remove(path);
  }

  // ---------------------------------------------------------------------------
  // Pending queue (evolver outputs)
  // ---------------------------------------------------------------------------

  async listPending(): Promise<PendingSkillRecord[]> {
    const names = await this.storage.list(this.pendingDir);
    const out: PendingSkillRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const path = join(this.pendingDir, name);
      const raw = await this.storage.read(path);
      const mtimeMs = await this.storage.mtime(path);
      if (raw === null || mtimeMs === null) continue;
      const id = name.replace(/\.md$/, '');
      const parsed = parseSkillFrontmatter(raw);
      const body = parsed?.body ?? raw;
      const fm = parsed?.raw ?? {};
      out.push({
        id,
        name: typeof fm.name === 'string' ? fm.name : id,
        description: typeof fm.description === 'string' ? fm.description : null,
        body,
        proposedAt: new Date(mtimeMs).toISOString(),
      });
    }
    out.sort((a, b) => (a.proposedAt < b.proposedAt ? 1 : -1));
    return out;
  }

  async pendingExists(id: string): Promise<boolean> {
    return this.storage.exists(join(this.pendingDir, `${id}.md`));
  }

  /** Move `<id>.md` from pending → live, replacing any existing live skill. */
  async approvePending(id: string): Promise<void> {
    const src = join(this.pendingDir, `${id}.md`);
    const body = await this.storage.read(src);
    if (body === null) throw notFoundGlobal(id);
    await this.storage.mkdir(this.skillsDir);
    await this.storage.write(join(this.skillsDir, `${id}.md`), body);
    await this.storage.remove(src);
  }

  async rejectPending(id: string): Promise<void> {
    const path = join(this.pendingDir, `${id}.md`);
    if (!(await this.storage.exists(path))) throw notFoundGlobal(id);
    await this.storage.remove(path);
  }

  // ---------------------------------------------------------------------------
  // Per-personality skills
  // ---------------------------------------------------------------------------

  async listPersonalitySkills(personalityId: string): Promise<PersonalitySkillRecord[]> {
    const dir = this.personalitySkillsDir(personalityId);
    const names = await this.storage.list(dir);
    const out: PersonalitySkillRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const skill = await this.readPersonalitySkill(dir, name);
      if (skill) out.push(skill);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  async getPersonalitySkill(
    personalityId: string,
    skillId: string,
  ): Promise<PersonalitySkillRecord | null> {
    return this.readPersonalitySkill(this.personalitySkillsDir(personalityId), `${skillId}.md`);
  }

  async createPersonalitySkill(
    personalityId: string,
    skillId: string,
    body: string,
  ): Promise<PersonalitySkillRecord> {
    const dir = this.personalitySkillsDir(personalityId);
    await this.storage.mkdir(dir);
    const path = join(dir, `${skillId}.md`);
    if (await this.storage.exists(path)) {
      throw new EthosError({
        code: 'SKILL_EXISTS',
        cause: `Skill "${skillId}" already exists for personality "${personalityId}".`,
        action: 'Pick a different id or open the existing skill to edit it.',
      });
    }
    await this.storage.write(path, ensureTrailingNewline(body));
    const created = await this.readPersonalitySkill(dir, `${skillId}.md`);
    if (!created) throw new Error(`createPersonalitySkill: failed to read back ${skillId}`);
    return created;
  }

  async updatePersonalitySkill(
    personalityId: string,
    skillId: string,
    body: string,
  ): Promise<PersonalitySkillRecord> {
    const dir = this.personalitySkillsDir(personalityId);
    const path = join(dir, `${skillId}.md`);
    if (!(await this.storage.exists(path))) throw notFoundPersonality(skillId);
    await this.storage.write(path, ensureTrailingNewline(body));
    const updated = await this.readPersonalitySkill(dir, `${skillId}.md`);
    if (!updated) throw new Error(`updatePersonalitySkill: failed to read back ${skillId}`);
    return updated;
  }

  async deletePersonalitySkill(personalityId: string, skillId: string): Promise<void> {
    const path = join(this.personalitySkillsDir(personalityId), `${skillId}.md`);
    if (!(await this.storage.exists(path))) throw notFoundPersonality(skillId);
    await this.storage.remove(path);
  }

  /**
   * Copy global skills into the personality's skills/ dir, byte-for-byte
   * matching the global file (so the SkillsInjector sees identical content
   * via mtime cache). Existing per-personality skills with the same id are
   * silently overwritten — the user explicitly chose to import.
   */
  async importGlobalIntoPersonality(
    personalityId: string,
    skillIds: string[],
  ): Promise<PersonalitySkillRecord[]> {
    const dir = this.personalitySkillsDir(personalityId);
    await this.storage.mkdir(dir);
    const imported: PersonalitySkillRecord[] = [];
    for (const skillId of skillIds) {
      const sourcePath = join(this.skillsDir, `${skillId}.md`);
      const sourceRaw = await this.storage.read(sourcePath);
      if (sourceRaw === null) {
        throw new EthosError({
          code: 'SKILL_NOT_FOUND',
          cause: `Global skill "${skillId}" not found in ~/.ethos/skills/.`,
          action: 'Use listSkills() to see what is available globally.',
        });
      }
      await this.storage.write(join(dir, `${skillId}.md`), sourceRaw);
      const created = await this.readPersonalitySkill(dir, `${skillId}.md`);
      if (created) imported.push(created);
    }
    return imported;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private personalitySkillsDir(personalityId: string): string {
    return join(this.personalitiesDir, personalityId, 'skills');
  }

  private async readGlobal(filename: string): Promise<SkillRecord | null> {
    const path = join(this.skillsDir, filename);
    const raw = await this.storage.read(path);
    const mtimeMs = await this.storage.mtime(path);
    if (raw === null || mtimeMs === null) return null;
    const id = filename.replace(/\.md$/, '');
    const parsed = parseSkillFrontmatter(raw);
    const fm = parsed?.raw ?? {};
    const body = parsed?.body ?? raw;
    return {
      id,
      name: typeof fm.name === 'string' ? fm.name : id,
      description: typeof fm.description === 'string' ? fm.description : null,
      frontmatter: fm,
      body,
      modifiedAt: new Date(mtimeMs).toISOString(),
    };
  }

  private async readPersonalitySkill(
    dir: string,
    filename: string,
  ): Promise<PersonalitySkillRecord | null> {
    const path = join(dir, filename);
    const raw = await this.storage.read(path);
    const mtimeMs = await this.storage.mtime(path);
    if (raw === null || mtimeMs === null) return null;
    const id = filename.replace(/\.md$/, '');
    const parsed = parseSkillFrontmatter(raw);
    const fm = parsed?.raw ?? {};
    const body = parsed?.body ?? raw;
    return {
      id,
      name: typeof fm.name === 'string' ? fm.name : id,
      description: typeof fm.description === 'string' ? fm.description : null,
      body,
      modifiedAt: new Date(mtimeMs).toISOString(),
    };
  }
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
}

function notFoundGlobal(id: string): EthosError {
  return new EthosError({
    code: 'SKILL_NOT_FOUND',
    cause: `Skill "${id}" not found.`,
    action: 'Use listSkills() to see what is currently installed.',
  });
}

function notFoundPersonality(id: string): EthosError {
  return new EthosError({
    code: 'SKILL_NOT_FOUND',
    cause: `Skill "${id}" not found.`,
    action: 'Use listPersonalitySkills() to see what is installed for this personality.',
  });
}
