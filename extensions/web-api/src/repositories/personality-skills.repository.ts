import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSkillFrontmatter } from '@ethosagent/skills';
import { EthosError } from '@ethosagent/types';
import type { PersonalitySkill } from '@ethosagent/web-contracts';
import type { PersonalityRepository } from './personality.repository';
import type { SkillsRepository } from './skills.repository';

// File-backed CRUD for per-personality skills under
// `~/.ethos/personalities/<id>/skills/*.md`. Mirrors SkillsRepository's
// shape — the file format is the same (markdown body + optional YAML
// frontmatter) — but scopes everything to a single personality.
//
// `importFromGlobal` reads from the global skills dir
// (`~/.ethos/skills/<id>.md`) via SkillsRepository and copies the body
// into the personality's skills directory. The SkillsInjector picks up
// the new files via mtime cache on the next chat turn.

export interface PersonalitySkillsRepositoryOptions {
  personalities: PersonalityRepository;
  globalSkills: SkillsRepository;
}

export class PersonalitySkillsRepository {
  constructor(private readonly opts: PersonalitySkillsRepositoryOptions) {}

  async list(personalityId: string): Promise<PersonalitySkill[]> {
    const dir = await this.requireSkillsDir(personalityId);
    const names = await readdirSafe(dir);
    const out: PersonalitySkill[] = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const skill = await this.readSkill(dir, name);
      if (skill) out.push(skill);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  async get(personalityId: string, skillId: string): Promise<PersonalitySkill | null> {
    const dir = await this.requireSkillsDir(personalityId);
    return this.readSkill(dir, `${skillId}.md`);
  }

  async create(personalityId: string, skillId: string, body: string): Promise<PersonalitySkill> {
    const dir = await this.requireSkillsDir(personalityId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${skillId}.md`);
    try {
      await writeFile(path, ensureTrailingNewline(body), { encoding: 'utf-8', flag: 'wx' });
    } catch (err) {
      if (isEEXIST(err)) {
        throw new EthosError({
          code: 'SKILL_EXISTS',
          cause: `Skill "${skillId}" already exists for personality "${personalityId}".`,
          action: 'Pick a different id or open the existing skill to edit it.',
        });
      }
      throw err;
    }
    const created = await this.readSkill(dir, `${skillId}.md`);
    if (!created) throw new Error(`createSkill: failed to read back ${skillId}`);
    return created;
  }

  async update(personalityId: string, skillId: string, body: string): Promise<PersonalitySkill> {
    const dir = await this.requireSkillsDir(personalityId);
    const path = join(dir, `${skillId}.md`);
    try {
      await stat(path);
    } catch {
      throw notFound(skillId);
    }
    await writeFile(path, ensureTrailingNewline(body), 'utf-8');
    const updated = await this.readSkill(dir, `${skillId}.md`);
    if (!updated) throw new Error(`updateSkill: failed to read back ${skillId}`);
    return updated;
  }

  async delete(personalityId: string, skillId: string): Promise<void> {
    const dir = await this.requireSkillsDir(personalityId);
    const path = join(dir, `${skillId}.md`);
    try {
      await unlink(path);
    } catch (err) {
      if (isENOENT(err)) throw notFound(skillId);
      throw err;
    }
  }

  /**
   * Copy global skills (from ~/.ethos/skills/<id>.md) into the
   * personality's skills/ dir. Skills already present in the
   * personality are silently overwritten — the user explicitly chose
   * to import. Returns the imported records.
   */
  async importFromGlobal(personalityId: string, skillIds: string[]): Promise<PersonalitySkill[]> {
    const dir = await this.requireSkillsDir(personalityId);
    await mkdir(dir, { recursive: true });
    const imported: PersonalitySkill[] = [];
    for (const skillId of skillIds) {
      const source = await this.opts.globalSkills.getSkill(skillId);
      if (!source) {
        throw new EthosError({
          code: 'SKILL_NOT_FOUND',
          cause: `Global skill "${skillId}" not found in ~/.ethos/skills/.`,
          action: 'Use skills.list to see what is available globally.',
        });
      }
      // Reconstruct the source body — frontmatter + body — so the
      // copied file is byte-equivalent to what the SkillsInjector
      // would see in the global dir.
      const body = rebuildFile(source);
      await writeFile(join(dir, `${skillId}.md`), body, 'utf-8');
      const created = await this.readSkill(dir, `${skillId}.md`);
      if (created) imported.push(created);
    }
    return imported;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async requireSkillsDir(personalityId: string): Promise<string> {
    const personality = this.opts.personalities.get(personalityId);
    if (!personality) {
      throw new EthosError({
        code: 'PERSONALITY_NOT_FOUND',
        cause: `Personality "${personalityId}" not found.`,
        action: 'Use personalities.list to see available ids.',
      });
    }
    return join(this.opts.personalities.userPathFor(personalityId), 'skills');
  }

  private async readSkill(dir: string, filename: string): Promise<PersonalitySkill | null> {
    const path = join(dir, filename);
    let raw: string;
    let mtime: Date;
    try {
      raw = await readFile(path, 'utf-8');
      const s = await stat(path);
      mtime = s.mtime;
    } catch {
      return null;
    }
    const id = filename.replace(/\.md$/, '');
    const parsed = parseSkillFrontmatter(raw);
    const fm = parsed?.raw ?? {};
    const body = parsed?.body ?? raw;
    return {
      id,
      name: typeof fm.name === 'string' ? fm.name : id,
      description: typeof fm.description === 'string' ? fm.description : null,
      body,
      modifiedAt: mtime.toISOString(),
    };
  }
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
}

function notFound(id: string): EthosError {
  return new EthosError({
    code: 'SKILL_NOT_FOUND',
    cause: `Skill "${id}" not found.`,
    action: 'Use personalities.skillsList to see what is currently installed for this personality.',
  });
}

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

function isEEXIST(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'EEXIST';
}

function rebuildFile(skill: import('@ethosagent/web-contracts').Skill): string {
  const fmKeys = Object.keys(skill.frontmatter);
  if (fmKeys.length === 0) return ensureTrailingNewline(skill.body);
  const fmLines = fmKeys.map((k) => `${k}: ${stringifyFrontmatterValue(skill.frontmatter[k])}`);
  return `---\n${fmLines.join('\n')}\n---\n\n${ensureTrailingNewline(skill.body)}`;
}

function stringifyFrontmatterValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}
