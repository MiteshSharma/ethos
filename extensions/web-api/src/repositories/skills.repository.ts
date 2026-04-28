import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSkillFrontmatter } from '@ethosagent/skills';
import { EthosError } from '@ethosagent/types';
import type { PendingSkill, Skill } from '@ethosagent/web-contracts';

// File-backed repository for the global skills library + the evolver's
// pending queue. Two directories under `~/.ethos/`:
//
//   skills/         — live skills the SkillsInjector pulls into prompts
//   skills/.pending — candidate files written by SkillEvolver.evolve()
//
// Per-personality skill directories (`~/.ethos/personalities/<id>/skills/`)
// are out of scope for this repository — they ship with the v1
// Personalities tab. v0.5 only wires the global library.

export interface SkillsRepositoryOptions {
  /** Root data dir — `~/.ethos/`. */
  dataDir: string;
}

export class SkillsRepository {
  private readonly skillsDir: string;
  private readonly pendingDir: string;

  constructor(opts: SkillsRepositoryOptions) {
    this.skillsDir = join(opts.dataDir, 'skills');
    this.pendingDir = join(this.skillsDir, '.pending');
  }

  /** Absolute path to the directory holding live skills. Used by the
   *  evolver service to move pending files in. */
  getSkillsDir(): string {
    return this.skillsDir;
  }

  /** Absolute path to the pending-candidates directory. */
  getPendingDir(): string {
    return this.pendingDir;
  }

  async listSkills(): Promise<Skill[]> {
    const names = await readdirSafe(this.skillsDir);
    const out: Skill[] = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const skill = await this.readSkill(name);
      if (skill) out.push(skill);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  async getSkill(id: string): Promise<Skill | null> {
    return this.readSkill(`${id}.md`);
  }

  async createSkill(id: string, body: string): Promise<Skill> {
    await mkdir(this.skillsDir, { recursive: true });
    const path = join(this.skillsDir, `${id}.md`);
    try {
      await writeFile(path, ensureTrailingNewline(body), { encoding: 'utf-8', flag: 'wx' });
    } catch (err) {
      if (isEEXIST(err)) {
        throw new EthosError({
          code: 'SKILL_EXISTS',
          cause: `A skill named "${id}" already exists.`,
          action: 'Pick a different id or open the existing skill to edit it.',
        });
      }
      throw err;
    }
    const created = await this.readSkill(`${id}.md`);
    if (!created) throw new Error(`createSkill: failed to read back ${id}`);
    return created;
  }

  async updateSkill(id: string, body: string): Promise<Skill> {
    const path = join(this.skillsDir, `${id}.md`);
    try {
      await stat(path);
    } catch {
      throw notFound(id);
    }
    await writeFile(path, ensureTrailingNewline(body), 'utf-8');
    const updated = await this.readSkill(`${id}.md`);
    if (!updated) throw new Error(`updateSkill: failed to read back ${id}`);
    return updated;
  }

  async deleteSkill(id: string): Promise<void> {
    const path = join(this.skillsDir, `${id}.md`);
    try {
      await unlink(path);
    } catch (err) {
      if (isENOENT(err)) throw notFound(id);
      throw err;
    }
  }

  async listPending(): Promise<PendingSkill[]> {
    const names = await readdirSafe(this.pendingDir);
    const out: PendingSkill[] = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const path = join(this.pendingDir, name);
      const id = name.replace(/\.md$/, '');
      let raw: string;
      let modifiedAt: Date;
      try {
        raw = await readFile(path, 'utf-8');
        const s = await stat(path);
        modifiedAt = s.mtime;
      } catch {
        continue;
      }
      const parsed = parseSkillFrontmatter(raw);
      const body = parsed?.body ?? raw;
      const fm = parsed?.raw ?? {};
      out.push({
        id,
        name: typeof fm.name === 'string' ? fm.name : id,
        description: typeof fm.description === 'string' ? fm.description : null,
        body,
        proposedAt: modifiedAt.toISOString(),
      });
    }
    out.sort((a, b) => (a.proposedAt < b.proposedAt ? 1 : -1));
    return out;
  }

  async pendingExists(id: string): Promise<boolean> {
    try {
      await stat(join(this.pendingDir, `${id}.md`));
      return true;
    } catch {
      return false;
    }
  }

  /** Move `<id>.md` from pending → skills, atomically replacing any
   *  existing live skill with the same id (the rewrite case). */
  async approvePending(id: string): Promise<void> {
    const src = join(this.pendingDir, `${id}.md`);
    const dst = join(this.skillsDir, `${id}.md`);
    let body: string;
    try {
      body = await readFile(src, 'utf-8');
    } catch (err) {
      if (isENOENT(err)) throw notFound(id);
      throw err;
    }
    await mkdir(this.skillsDir, { recursive: true });
    await writeFile(dst, body, 'utf-8');
    await unlink(src);
  }

  async rejectPending(id: string): Promise<void> {
    const src = join(this.pendingDir, `${id}.md`);
    try {
      await unlink(src);
    } catch (err) {
      if (isENOENT(err)) throw notFound(id);
      throw err;
    }
  }

  private async readSkill(filename: string): Promise<Skill | null> {
    const path = join(this.skillsDir, filename);
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
      frontmatter: fm,
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
    action: 'Use skills.list to see what is currently installed.',
  });
}

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

function isEEXIST(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'EEXIST';
}
