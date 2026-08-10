import { join } from 'node:path';
import { assertSafeId, EthosError, type Storage } from '@ethosagent/types';
import { parseEthosRequires } from './dialects/ethos-namespace';
import { checkRequirements, checkSkillFrontmatter, parseSkillFrontmatter } from './skill-compat';

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
  source: 'system' | 'user' | 'evolver' | 'personality';
  readonly: boolean;
  /**
   * Gap 11 — non-null when the skill fails an `ethos.requires` gate
   * (env / tools / os). Tool gating needs the `availableTools` option;
   * without it the tools gate is skipped (availability unknown).
   */
  unavailableReason: string | null;
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
  /** Read-only system skills directory (subdirectory layout: `<id>/SKILL.md`). */
  catalogDir?: string;
  /** Storage backend. Injected by the composition root; required — never
   *  falls back to raw disk. */
  storage: Storage;
  /**
   * Gap 11 — lazy getter for the tool names registered in this deployment,
   * used to evaluate `ethos.requires.tools`. A getter (not a snapshot) so
   * tools registered after construction (MCP, plugins) are visible. Pass
   * `() => new Set(registry.getAvailable().map((t) => t.name))` from boot
   * code. When omitted, the tools gate is skipped (availability unknown).
   */
  availableTools?: () => Set<string>;
}

export class SkillsLibrary {
  private readonly storage: Storage;
  private readonly skillsDir: string;
  private readonly pendingDir: string;
  private readonly personalitiesDir: string;
  private readonly catalogDir: string | null;
  private readonly availableTools: (() => Set<string>) | null;
  private catalogIndex: Map<string, string> | null = null;

  constructor(opts: SkillsLibraryOptions) {
    this.storage = opts.storage;
    this.skillsDir = join(opts.dataDir, 'skills');
    this.pendingDir = join(this.skillsDir, '.pending');
    this.personalitiesDir = join(opts.dataDir, 'personalities');
    this.catalogDir = opts.catalogDir ?? null;
    this.availableTools = opts.availableTools ?? null;
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

  async listSkills(opts?: { includeUnavailable?: boolean }): Promise<SkillRecord[]> {
    const systemSkills = await this.readSystemSkills();

    const names = await this.storage.list(this.skillsDir);
    const userSkills: SkillRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const skill = await this.readGlobal(name);
      if (skill) userSkills.push(skill);
    }

    const userIds = new Set(userSkills.map((s) => s.id));
    const merged = [...systemSkills.filter((s) => !userIds.has(s.id)), ...userSkills];
    merged.sort((a, b) => a.name.localeCompare(b.name));
    if (opts?.includeUnavailable) return merged;
    return merged.filter((s) => s.unavailableReason === null);
  }

  async getSkill(id: string): Promise<SkillRecord | null> {
    assertSafeId(id, 'skillId');
    const user = await this.readGlobal(`${id}.md`);
    if (user) return user;
    return this.readSystemSkill(id);
  }

  async createSkill(id: string, body: string): Promise<SkillRecord> {
    assertSafeId(id, 'skillId');
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
    assertSafeId(id, 'skillId');
    const path = join(this.skillsDir, `${id}.md`);
    if (!(await this.storage.exists(path))) throw notFoundGlobal(id);
    await this.storage.write(path, ensureTrailingNewline(body));
    const updated = await this.readGlobal(`${id}.md`);
    if (!updated) throw new Error(`updateSkill: failed to read back ${id}`);
    return updated;
  }

  async deleteSkill(id: string): Promise<void> {
    assertSafeId(id, 'skillId');
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
    assertSafeId(id, 'skillId');
    return this.storage.exists(join(this.pendingDir, `${id}.md`));
  }

  /**
   * Move `<id>.md` from pending → live, replacing any existing live skill.
   *
   * Refuses to promote a file whose frontmatter does not parse: the live dir
   * is loaded at startup, so an unparseable file there is a boot failure. The
   * pending file is left in place so it can be inspected or edited.
   */
  async approvePending(id: string): Promise<void> {
    assertSafeId(id, 'skillId');
    const src = join(this.pendingDir, `${id}.md`);
    const body = await this.storage.read(src);
    if (body === null) throw notFoundGlobal(id);
    const check = checkSkillFrontmatter(body);
    if (!check.ok) throw invalidFrontmatter(`${id}.md`, check.error);
    await this.storage.mkdir(this.skillsDir);
    await this.storage.write(join(this.skillsDir, `${id}.md`), body);
    await this.storage.remove(src);
  }

  async rejectPending(id: string): Promise<void> {
    assertSafeId(id, 'skillId');
    const path = join(this.pendingDir, `${id}.md`);
    if (!(await this.storage.exists(path))) throw notFoundGlobal(id);
    await this.storage.remove(path);
  }

  // ---------------------------------------------------------------------------
  // Per-personality skills
  // ---------------------------------------------------------------------------

  async listPersonalitySkills(personalityId: string): Promise<PersonalitySkillRecord[]> {
    assertSafeId(personalityId, 'personalityId');
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
    assertSafeId(personalityId, 'personalityId');
    assertSafeId(skillId, 'skillId');
    return this.readPersonalitySkill(this.personalitySkillsDir(personalityId), `${skillId}.md`);
  }

  async createPersonalitySkill(
    personalityId: string,
    skillId: string,
    body: string,
  ): Promise<PersonalitySkillRecord> {
    assertSafeId(personalityId, 'personalityId');
    assertSafeId(skillId, 'skillId');
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
    assertSafeId(personalityId, 'personalityId');
    assertSafeId(skillId, 'skillId');
    const dir = this.personalitySkillsDir(personalityId);
    const path = join(dir, `${skillId}.md`);
    if (!(await this.storage.exists(path))) throw notFoundPersonality(skillId);
    await this.storage.write(path, ensureTrailingNewline(body));
    const updated = await this.readPersonalitySkill(dir, `${skillId}.md`);
    if (!updated) throw new Error(`updatePersonalitySkill: failed to read back ${skillId}`);
    return updated;
  }

  async deletePersonalitySkill(personalityId: string, skillId: string): Promise<void> {
    assertSafeId(personalityId, 'personalityId');
    assertSafeId(skillId, 'skillId');
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
    assertSafeId(personalityId, 'personalityId');
    for (const sid of skillIds) assertSafeId(sid, 'skillId');
    const dir = this.personalitySkillsDir(personalityId);
    await this.storage.mkdir(dir);
    const imported: PersonalitySkillRecord[] = [];
    for (const skillId of skillIds) {
      const sourceRaw = await this.resolveSkillContent(skillId);
      if (sourceRaw === null) {
        throw new EthosError({
          code: 'SKILL_NOT_FOUND',
          cause: `Skill "${skillId}" not found in user skills or system catalog.`,
          action: 'Use listSkills() to see what is available.',
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
      source: 'user',
      readonly: false,
      unavailableReason: this.computeUnavailableReason(fm),
    };
  }

  /**
   * Gap 11 — evaluate `ethos.requires` gates for a skill's frontmatter.
   * Passes null for the tool set when no `availableTools` getter was
   * provided (tools gate skipped — availability unknown).
   */
  private computeUnavailableReason(fm: Record<string, unknown>): string | null {
    return checkRequirements(parseEthosRequires(fm), this.availableTools?.() ?? null);
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

  private async getCatalogIndex(): Promise<Map<string, string>> {
    if (this.catalogIndex) return this.catalogIndex;
    const index = new Map<string, string>();
    if (!this.catalogDir) {
      this.catalogIndex = index;
      return index;
    }
    const entries = await this.storage.listEntries(this.catalogDir);
    for (const entry of entries) {
      if (!entry.isDir) continue;
      const directPath = join(this.catalogDir, entry.name, 'SKILL.md');
      if (await this.storage.exists(directPath)) {
        const existing = index.get(entry.name);
        if (existing) {
          throw new EthosError({
            code: 'SKILL_EXISTS',
            cause: `Duplicate system skill id "${entry.name}" found at "${directPath}" and "${existing}".`,
            action: 'Rename one of the skills so each leaf directory has a unique name.',
          });
        }
        index.set(entry.name, directPath);
        continue;
      }
      const subEntries = await this.storage.listEntries(join(this.catalogDir, entry.name));
      for (const sub of subEntries) {
        if (!sub.isDir) continue;
        const nestedPath = join(this.catalogDir, entry.name, sub.name, 'SKILL.md');
        if (await this.storage.exists(nestedPath)) {
          const existing = index.get(sub.name);
          if (existing) {
            throw new EthosError({
              code: 'SKILL_EXISTS',
              cause: `Duplicate system skill id "${sub.name}" found at "${nestedPath}" and "${existing}".`,
              action: 'Rename one of the skills so each leaf directory has a unique name.',
            });
          }
          index.set(sub.name, nestedPath);
        }
      }
    }
    this.catalogIndex = index;
    return index;
  }

  private async readSystemSkills(): Promise<SkillRecord[]> {
    const index = await this.getCatalogIndex();
    const out: SkillRecord[] = [];
    for (const [id, path] of index) {
      const skill = await this.readSystemSkillAt(id, path);
      if (skill) out.push(skill);
    }
    return out;
  }

  private async readSystemSkill(id: string): Promise<SkillRecord | null> {
    const index = await this.getCatalogIndex();
    const path = index.get(id);
    if (!path) return null;
    return this.readSystemSkillAt(id, path);
  }

  private async readSystemSkillAt(id: string, path: string): Promise<SkillRecord | null> {
    const raw = await this.storage.read(path);
    const mtimeMs = await this.storage.mtime(path);
    if (raw === null || mtimeMs === null) return null;
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
      source: 'system',
      readonly: true,
      unavailableReason: this.computeUnavailableReason(fm),
    };
  }

  /** Try user skillsDir first, then catalogDir. Returns raw file content. */
  private async resolveSkillContent(skillId: string): Promise<string | null> {
    const userPath = join(this.skillsDir, `${skillId}.md`);
    const userRaw = await this.storage.read(userPath);
    if (userRaw !== null) return userRaw;
    const index = await this.getCatalogIndex();
    const systemPath = index.get(skillId);
    if (!systemPath) return null;
    return this.storage.read(systemPath);
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

function invalidFrontmatter(fileName: string, error: string): EthosError {
  return new EthosError({
    // Reuses the existing skill-install code — EthosErrorCode is a closed
    // union with a docs round-trip gate; a new code is not worth a schema
    // change for this case.
    code: 'SKILL_INSTALL_FAILED',
    cause: `Skill "${fileName}" has unparseable YAML frontmatter: ${error}`,
    action:
      'Fix the frontmatter (values containing ": " must be quoted) and approve it again, or reject it.',
  });
}

function notFoundPersonality(id: string): EthosError {
  return new EthosError({
    code: 'SKILL_NOT_FOUND',
    cause: `Skill "${id}" not found.`,
    action: 'Use listPersonalitySkills() to see what is installed for this personality.',
  });
}
