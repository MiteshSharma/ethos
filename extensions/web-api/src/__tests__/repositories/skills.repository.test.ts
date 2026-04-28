import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillsRepository } from '../../repositories/skills.repository';

describe('SkillsRepository', () => {
  let dir: string;
  let repo: SkillsRepository;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-skills-'));
    repo = new SkillsRepository({ dataDir: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('listSkills', () => {
    it('returns empty when no skills directory exists yet', async () => {
      expect(await repo.listSkills()).toEqual([]);
    });

    it('parses frontmatter and returns sorted by name', async () => {
      await mkdir(join(dir, 'skills'), { recursive: true });
      await writeFile(
        join(dir, 'skills', 'zebra.md'),
        '---\nname: Zebra skill\ndescription: about zebras\n---\n\nbody',
      );
      await writeFile(join(dir, 'skills', 'alpha.md'), '---\nname: Alpha skill\n---\n\nalpha body');

      const skills = await repo.listSkills();
      expect(skills.map((s) => s.name)).toEqual(['Alpha skill', 'Zebra skill']);
      expect(skills[0]?.body.trim()).toBe('alpha body');
      expect(skills[1]?.description).toBe('about zebras');
    });

    it('falls back to id when frontmatter has no name', async () => {
      await mkdir(join(dir, 'skills'), { recursive: true });
      await writeFile(join(dir, 'skills', 'plain.md'), 'just body, no frontmatter');
      const skills = await repo.listSkills();
      expect(skills[0]).toMatchObject({ id: 'plain', name: 'plain', description: null });
    });
  });

  describe('createSkill', () => {
    it('writes the file and returns the parsed skill', async () => {
      const created = await repo.createSkill('hello', '---\nname: Hi\n---\n\nbody');
      expect(created.id).toBe('hello');
      expect(created.name).toBe('Hi');
      const onDisk = await readFile(join(dir, 'skills', 'hello.md'), 'utf-8');
      expect(onDisk).toContain('name: Hi');
    });

    it('throws SKILL_EXISTS when the file already exists', async () => {
      await repo.createSkill('dup', 'x');
      await expect(repo.createSkill('dup', 'y')).rejects.toMatchObject({ code: 'SKILL_EXISTS' });
    });
  });

  describe('updateSkill', () => {
    it('overwrites existing content', async () => {
      await repo.createSkill('s', 'first');
      const updated = await repo.updateSkill('s', '---\nname: Renamed\n---\n\nsecond');
      expect(updated.name).toBe('Renamed');
      expect(updated.body.trim()).toBe('second');
    });

    it('throws SKILL_NOT_FOUND for missing skills', async () => {
      await expect(repo.updateSkill('missing', 'x')).rejects.toMatchObject({
        code: 'SKILL_NOT_FOUND',
      });
    });
  });

  describe('deleteSkill', () => {
    it('removes the file from disk', async () => {
      await repo.createSkill('gone', 'x');
      await repo.deleteSkill('gone');
      expect(await repo.getSkill('gone')).toBeNull();
    });

    it('throws SKILL_NOT_FOUND for missing skills', async () => {
      await expect(repo.deleteSkill('missing')).rejects.toMatchObject({
        code: 'SKILL_NOT_FOUND',
      });
    });
  });

  describe('approvePending', () => {
    it('moves the file from .pending into the live dir', async () => {
      await mkdir(join(dir, 'skills', '.pending'), { recursive: true });
      await writeFile(
        join(dir, 'skills', '.pending', 'cand.md'),
        '---\nname: Candidate\n---\n\nthe body',
      );

      await repo.approvePending('cand');

      const live = await repo.getSkill('cand');
      expect(live?.name).toBe('Candidate');
      expect(await repo.pendingExists('cand')).toBe(false);
    });

    it('overwrites a live skill of the same id (rewrite case)', async () => {
      await repo.createSkill('rewrite-me', 'old body');
      await mkdir(join(dir, 'skills', '.pending'), { recursive: true });
      await writeFile(join(dir, 'skills', '.pending', 'rewrite-me.md'), 'new body');

      await repo.approvePending('rewrite-me');

      const live = await repo.getSkill('rewrite-me');
      expect(live?.body).toBe('new body');
    });

    it('throws SKILL_NOT_FOUND when the candidate is missing', async () => {
      await expect(repo.approvePending('ghost')).rejects.toMatchObject({
        code: 'SKILL_NOT_FOUND',
      });
    });
  });

  describe('rejectPending', () => {
    it('deletes the candidate file', async () => {
      await mkdir(join(dir, 'skills', '.pending'), { recursive: true });
      await writeFile(join(dir, 'skills', '.pending', 'reject-me.md'), 'x');
      await repo.rejectPending('reject-me');
      expect(await repo.pendingExists('reject-me')).toBe(false);
    });

    it('throws SKILL_NOT_FOUND when the candidate is missing', async () => {
      await expect(repo.rejectPending('ghost')).rejects.toMatchObject({
        code: 'SKILL_NOT_FOUND',
      });
    });
  });

  describe('listPending', () => {
    it('returns the .pending dir contents, newest first', async () => {
      await mkdir(join(dir, 'skills', '.pending'), { recursive: true });
      await writeFile(join(dir, 'skills', '.pending', 'first.md'), '---\nname: First\n---\n\na');
      await new Promise((r) => setTimeout(r, 10));
      await writeFile(join(dir, 'skills', '.pending', 'second.md'), '---\nname: Second\n---\n\nb');

      const pending = await repo.listPending();
      expect(pending.map((p) => p.id)).toEqual(['second', 'first']);
    });
  });
});
