import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Personality CRUD now lives directly on FilePersonalityRegistry. This
// test is the old PersonalityRepository regression suite (kept intact)
// pointed at the registry's create/update/deletePersonality/duplicate
// methods so the on-disk round-trip + mtime cache still hold.

describe('FilePersonalityRegistry — CRUD mutations', () => {
  let dir: string;
  let registry: FilePersonalityRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-personality-'));
    registry = new FilePersonalityRegistry(undefined, dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('writes the four files and refreshes the registry', async () => {
      const created = await registry.create({
        id: 'strategist',
        name: 'Strategist',
        description: 'thinks in moves',
        model: 'claude-opus-4-7',
        toolset: ['web_search', 'memory_read'],
        ethosMd: '# I am a strategist\n',
      });

      expect(created.config.id).toBe('strategist');
      expect(created.config.name).toBe('Strategist');
      expect(created.config.toolset).toEqual(['web_search', 'memory_read']);
      expect(created.builtin).toBe(false);

      const personalityDir = join(dir, 'personalities', 'strategist');
      expect(await readFile(join(personalityDir, 'config.yaml'), 'utf-8')).toContain(
        'name: Strategist',
      );
      expect(await readFile(join(personalityDir, 'toolset.yaml'), 'utf-8')).toContain(
        '- web_search',
      );
      expect(await readFile(join(personalityDir, 'ETHOS.md'), 'utf-8')).toBe(
        '# I am a strategist\n',
      );
    });

    it('rejects duplicate ids with PERSONALITY_EXISTS', async () => {
      await registry.create({ id: 'one', name: 'One', toolset: [], ethosMd: '' });
      await expect(
        registry.create({ id: 'one', name: 'One redux', toolset: [], ethosMd: '' }),
      ).rejects.toMatchObject({ code: 'PERSONALITY_EXISTS' });
    });
  });

  describe('update', () => {
    it('writes ETHOS.md when patch.ethosMd is present', async () => {
      await registry.create({ id: 'p', name: 'P', toolset: [], ethosMd: 'old' });
      await registry.update('p', { ethosMd: 'new identity' });
      expect(await registry.readEthosMd('p')).toBe('new identity');
    });

    it('updates config.yaml when name/description/model change', async () => {
      await registry.create({ id: 'p', name: 'Old', toolset: [], ethosMd: '' });
      await registry.update('p', { name: 'New', description: 'now updated' });
      const yaml = await readFile(join(dir, 'personalities', 'p', 'config.yaml'), 'utf-8');
      expect(yaml).toContain('name: New');
      expect(yaml).toContain('description: now updated');
    });

    it('refreshes toolset.yaml when patch.toolset is present', async () => {
      await registry.create({ id: 'p', name: 'P', toolset: ['a'], ethosMd: '' });
      await registry.update('p', { toolset: ['x', 'y'] });
      const yaml = await readFile(join(dir, 'personalities', 'p', 'toolset.yaml'), 'utf-8');
      expect(yaml).toContain('- x');
      expect(yaml).toContain('- y');
      expect(yaml).not.toContain('- a');
    });

    it('rejects builtin personalities with PERSONALITY_READ_ONLY', async () => {
      registry.define({
        id: 'reviewer',
        name: 'Reviewer',
        ethosFile: '/usr/share/ethos/personalities/reviewer/ETHOS.md',
      });
      await expect(registry.update('reviewer', { ethosMd: 'try' })).rejects.toMatchObject({
        code: 'PERSONALITY_READ_ONLY',
      });
    });

    it('rejects unknown ids with PERSONALITY_NOT_FOUND', async () => {
      await expect(registry.update('ghost', { ethosMd: 'x' })).rejects.toMatchObject({
        code: 'PERSONALITY_NOT_FOUND',
      });
    });
  });

  describe('deletePersonality', () => {
    it('removes the directory and forgets the personality', async () => {
      await registry.create({ id: 'gone', name: 'Gone', toolset: [], ethosMd: '' });
      await registry.deletePersonality('gone');
      expect(registry.describe('gone')).toBeNull();
      await expect(stat(join(dir, 'personalities', 'gone'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('rejects builtins', async () => {
      registry.define({
        id: 'builtin',
        name: 'Builtin',
        ethosFile: '/usr/share/ethos/personalities/builtin/ETHOS.md',
      });
      await expect(registry.deletePersonality('builtin')).rejects.toMatchObject({
        code: 'PERSONALITY_READ_ONLY',
      });
    });
  });

  describe('duplicate', () => {
    it('copies a built-in into ~/.ethos/personalities/ with the new id and a renamed display name', async () => {
      const builtinDir = join(dir, 'fake-builtins');
      const sourceDir = join(builtinDir, 'engineer');
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        join(sourceDir, 'config.yaml'),
        'name: Engineer\ndescription: terse + correct\n',
      );
      await writeFile(join(sourceDir, 'toolset.yaml'), '- terminal\n- read_file\n');
      await writeFile(join(sourceDir, 'ETHOS.md'), '# Engineer body\n');
      await registry.loadFromDirectory(builtinDir);

      const dup = await registry.duplicate('engineer', 'engineer-copy');
      expect(dup.config.id).toBe('engineer-copy');
      expect(dup.config.name).toBe('Engineer (copy)');
      expect(dup.builtin).toBe(false);

      const copyDir = join(dir, 'personalities', 'engineer-copy');
      expect(await readFile(join(copyDir, 'ETHOS.md'), 'utf-8')).toBe('# Engineer body\n');
      const yaml = await readFile(join(copyDir, 'config.yaml'), 'utf-8');
      expect(yaml).toContain('name: Engineer (copy)');
      expect(yaml).toContain('description: terse + correct');
    });

    it('rejects when the new id collides', async () => {
      await registry.create({ id: 'taken', name: 'Taken', toolset: [], ethosMd: '' });
      registry.define({
        id: 'src',
        name: 'Src',
        ethosFile: '/tmp/fake/src/ETHOS.md',
      });
      await expect(registry.duplicate('src', 'taken')).rejects.toMatchObject({
        code: 'PERSONALITY_EXISTS',
      });
    });

    it('rejects when the source is unknown', async () => {
      await expect(registry.duplicate('missing', 'new')).rejects.toMatchObject({
        code: 'PERSONALITY_NOT_FOUND',
      });
    });
  });
});
