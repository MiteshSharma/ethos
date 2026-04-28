import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PersonalityRepository } from '../../repositories/personality.repository';
import { PersonalitySkillsRepository } from '../../repositories/personality-skills.repository';
import { SkillsRepository } from '../../repositories/skills.repository';

describe('PersonalitySkillsRepository', () => {
  let dir: string;
  let registry: FilePersonalityRegistry;
  let personalities: PersonalityRepository;
  let globalSkills: SkillsRepository;
  let repo: PersonalitySkillsRepository;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-pskills-'));
    registry = new FilePersonalityRegistry();
    personalities = new PersonalityRepository({ registry, userPersonalitiesDir: dir });
    globalSkills = new SkillsRepository({ dataDir: dir });
    repo = new PersonalitySkillsRepository({ personalities, globalSkills });
    await personalities.create({ id: 'p', name: 'P', toolset: [], ethosMd: '' });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('list returns empty when no skills/ subdir exists yet', async () => {
    expect(await repo.list('p')).toEqual([]);
  });

  it('create + list round-trip', async () => {
    await repo.create('p', 'tighten-prose', '---\nname: Tighten prose\n---\n\nbody');
    const skills = await repo.list('p');
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ id: 'tighten-prose', name: 'Tighten prose' });
  });

  it('update overwrites existing content', async () => {
    await repo.create('p', 's', 'first');
    await repo.update('p', 's', '---\nname: Renamed\n---\n\nsecond');
    const skill = await repo.get('p', 's');
    expect(skill?.name).toBe('Renamed');
    expect(skill?.body.trim()).toBe('second');
  });

  it('delete removes the file', async () => {
    await repo.create('p', 'gone', 'x');
    await repo.delete('p', 'gone');
    expect(await repo.get('p', 'gone')).toBeNull();
  });

  it('importFromGlobal copies the body byte-equivalent', async () => {
    await globalSkills.createSkill(
      'shared',
      '---\nname: Shared skill\ndescription: shared\n---\n\nbody',
    );
    const imported = await repo.importFromGlobal('p', ['shared']);
    expect(imported).toHaveLength(1);
    const onDisk = await readFile(
      join(personalities.userPathFor('p'), 'skills', 'shared.md'),
      'utf-8',
    );
    expect(onDisk).toContain('name: Shared skill');
    expect(onDisk).toContain('description: shared');
  });

  it('importFromGlobal throws when a global skill is missing', async () => {
    await expect(repo.importFromGlobal('p', ['ghost'])).rejects.toMatchObject({
      code: 'SKILL_NOT_FOUND',
    });
  });

  it('all methods reject unknown personality ids', async () => {
    await expect(repo.list('missing')).rejects.toMatchObject({ code: 'PERSONALITY_NOT_FOUND' });
    await expect(repo.create('missing', 's', 'x')).rejects.toMatchObject({
      code: 'PERSONALITY_NOT_FOUND',
    });
  });
});
