import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { SkillsLibrary } from '../skills-library';

const DATA = '/data';

describe('SkillsLibrary', () => {
  let storage: InMemoryStorage;
  let lib: SkillsLibrary;

  beforeEach(() => {
    storage = new InMemoryStorage();
    lib = new SkillsLibrary({ dataDir: DATA, storage });
  });

  describe('listSkills', () => {
    it('returns empty when no skills directory exists yet', async () => {
      expect(await lib.listSkills()).toEqual([]);
    });

    it('parses frontmatter and returns sorted by name', async () => {
      await storage.mkdir(join(DATA, 'skills'));
      await storage.write(
        join(DATA, 'skills', 'zebra.md'),
        '---\nname: Zebra skill\ndescription: about zebras\n---\n\nbody',
      );
      await storage.write(join(DATA, 'skills', 'alpha.md'), '---\nname: Alpha skill\n---\n\nalpha body');

      const skills = await lib.listSkills();
      expect(skills.map((s) => s.name)).toEqual(['Alpha skill', 'Zebra skill']);
      expect(skills[0]?.body.trim()).toBe('alpha body');
      expect(skills[1]?.description).toBe('about zebras');
    });

    it('falls back to id when frontmatter has no name', async () => {
      await storage.mkdir(join(DATA, 'skills'));
      await storage.write(join(DATA, 'skills', 'plain.md'), 'just body, no frontmatter');
      const skills = await lib.listSkills();
      expect(skills[0]).toMatchObject({ id: 'plain', name: 'plain', description: null });
    });
  });

  describe('createSkill', () => {
    it('writes the file and returns the parsed skill', async () => {
      const created = await lib.createSkill('hello', '---\nname: Hi\n---\n\nbody');
      expect(created.id).toBe('hello');
      expect(created.name).toBe('Hi');
      expect(await storage.read(join(DATA, 'skills', 'hello.md'))).toContain('name: Hi');
    });

    it('throws SKILL_EXISTS when the file already exists', async () => {
      await lib.createSkill('dup', 'x');
      await expect(lib.createSkill('dup', 'y')).rejects.toMatchObject({ code: 'SKILL_EXISTS' });
    });
  });

  describe('updateSkill', () => {
    it('overwrites existing content', async () => {
      await lib.createSkill('s', 'first');
      const updated = await lib.updateSkill('s', '---\nname: Renamed\n---\n\nsecond');
      expect(updated.name).toBe('Renamed');
      expect(updated.body.trim()).toBe('second');
    });

    it('throws SKILL_NOT_FOUND for missing skills', async () => {
      await expect(lib.updateSkill('missing', 'x')).rejects.toMatchObject({
        code: 'SKILL_NOT_FOUND',
      });
    });
  });

  describe('deleteSkill', () => {
    it('removes the file from disk', async () => {
      await lib.createSkill('gone', 'x');
      await lib.deleteSkill('gone');
      expect(await lib.getSkill('gone')).toBeNull();
    });

    it('throws SKILL_NOT_FOUND for missing skills', async () => {
      await expect(lib.deleteSkill('missing')).rejects.toMatchObject({
        code: 'SKILL_NOT_FOUND',
      });
    });
  });

  describe('approvePending', () => {
    it('moves the file from .pending into the live dir', async () => {
      await storage.mkdir(join(DATA, 'skills', '.pending'));
      await storage.write(
        join(DATA, 'skills', '.pending', 'cand.md'),
        '---\nname: Candidate\n---\n\nthe body',
      );

      await lib.approvePending('cand');

      const live = await lib.getSkill('cand');
      expect(live?.name).toBe('Candidate');
      expect(await lib.pendingExists('cand')).toBe(false);
    });

    it('overwrites a live skill of the same id (rewrite case)', async () => {
      await lib.createSkill('rewrite-me', 'old body');
      await storage.mkdir(join(DATA, 'skills', '.pending'));
      await storage.write(join(DATA, 'skills', '.pending', 'rewrite-me.md'), 'new body');

      await lib.approvePending('rewrite-me');

      const live = await lib.getSkill('rewrite-me');
      expect(live?.body).toBe('new body');
    });

    it('throws SKILL_NOT_FOUND when the candidate is missing', async () => {
      await expect(lib.approvePending('ghost')).rejects.toMatchObject({
        code: 'SKILL_NOT_FOUND',
      });
    });
  });

  describe('rejectPending', () => {
    it('deletes the candidate file', async () => {
      await storage.mkdir(join(DATA, 'skills', '.pending'));
      await storage.write(join(DATA, 'skills', '.pending', 'reject-me.md'), 'x');
      await lib.rejectPending('reject-me');
      expect(await lib.pendingExists('reject-me')).toBe(false);
    });

    it('throws SKILL_NOT_FOUND when the candidate is missing', async () => {
      await expect(lib.rejectPending('ghost')).rejects.toMatchObject({
        code: 'SKILL_NOT_FOUND',
      });
    });
  });

  describe('listPending', () => {
    it('returns the .pending dir contents, newest first', async () => {
      await storage.mkdir(join(DATA, 'skills', '.pending'));
      await storage.write(
        join(DATA, 'skills', '.pending', 'first.md'),
        '---\nname: First\n---\n\na',
      );
      // InMemoryStorage uses a monotonic clock — each write gets a higher mtime,
      // so 'second.md' is guaranteed newer than 'first.md' without sleeping.
      await storage.write(
        join(DATA, 'skills', '.pending', 'second.md'),
        '---\nname: Second\n---\n\nb',
      );

      const pending = await lib.listPending();
      expect(pending.map((p) => p.id)).toEqual(['second', 'first']);
    });
  });

  describe('per-personality skills', () => {
    it('writes under personalities/<id>/skills/', async () => {
      const skill = await lib.createPersonalitySkill('p', 'note', '---\nname: A note\n---\n\nbody');
      expect(skill.name).toBe('A note');
      expect(
        await storage.read(join(DATA, 'personalities', 'p', 'skills', 'note.md')),
      ).toContain('name: A note');
    });

    it('importGlobalIntoPersonality copies global into per-personality dir byte-for-byte', async () => {
      await lib.createSkill('shared', '---\nname: Shared\n---\n\nbody');
      const imported = await lib.importGlobalIntoPersonality('p', ['shared']);
      expect(imported).toHaveLength(1);
      expect(
        await storage.read(join(DATA, 'personalities', 'p', 'skills', 'shared.md')),
      ).toContain('name: Shared');
    });

    it('importGlobalIntoPersonality throws when source missing', async () => {
      await expect(lib.importGlobalIntoPersonality('p', ['ghost'])).rejects.toMatchObject({
        code: 'SKILL_NOT_FOUND',
      });
    });
  });
});
