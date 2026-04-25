import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPersonalityRegistry, FilePersonalityRegistry } from '../index';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-personalities-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('FilePersonalityRegistry', () => {
  describe('built-ins via createPersonalityRegistry()', () => {
    it('loads all 5 built-in personalities', async () => {
      const registry = await createPersonalityRegistry();
      const ids = registry.list().map((p) => p.id);
      expect(ids).toContain('researcher');
      expect(ids).toContain('engineer');
      expect(ids).toContain('reviewer');
      expect(ids).toContain('coach');
      expect(ids).toContain('operator');
    });

    it('researcher has ethosFile and toolset', async () => {
      const registry = await createPersonalityRegistry();
      const researcher = registry.get('researcher');
      expect(researcher).toBeDefined();
      expect(researcher?.ethosFile).toBeTruthy();
      expect(researcher?.toolset?.length).toBeGreaterThan(0);
      expect(researcher?.toolset).toContain('web_search');
    });

    it('reviewer toolset is read-only (no terminal or write tools)', async () => {
      const registry = await createPersonalityRegistry();
      const reviewer = registry.get('reviewer');
      expect(reviewer?.toolset).not.toContain('terminal');
      expect(reviewer?.toolset).not.toContain('write_file');
    });

    it('operator has terminal but no web tools', async () => {
      const registry = await createPersonalityRegistry();
      const operator = registry.get('operator');
      expect(operator?.toolset).toContain('terminal');
      expect(operator?.toolset).not.toContain('web_search');
    });

    it('default personality is researcher', async () => {
      const registry = await createPersonalityRegistry();
      expect(registry.getDefault().id).toBe('researcher');
    });

    it('researcher memoryScope is global', async () => {
      const registry = await createPersonalityRegistry();
      expect(registry.get('researcher')?.memoryScope).toBe('global');
    });

    it('reviewer memoryScope is per-personality', async () => {
      const registry = await createPersonalityRegistry();
      expect(registry.get('reviewer')?.memoryScope).toBe('per-personality');
    });
  });

  describe('loadFromDirectory', () => {
    it('loads a user-defined personality from directory', async () => {
      const personalityDir = join(testDir, 'strategist');
      await mkdir(personalityDir);
      await writeFile(
        join(personalityDir, 'config.yaml'),
        'name: Strategist\ndescription: Thinks in frameworks\nmodel: claude-opus-4-7\nmemoryScope: global\n',
      );
      await writeFile(join(personalityDir, 'ETHOS.md'), '# Strategist\n\nI think in frameworks.');
      await writeFile(
        join(personalityDir, 'toolset.yaml'),
        '- web_search\n- read_file\n- memory_read\n',
      );

      const registry = new FilePersonalityRegistry();
      await registry.loadFromDirectory(testDir);

      const strategist = registry.get('strategist');
      expect(strategist).toBeDefined();
      expect(strategist?.name).toBe('Strategist');
      expect(strategist?.model).toBe('claude-opus-4-7');
      expect(strategist?.ethosFile).toBeTruthy();
      expect(strategist?.toolset).toContain('web_search');
      expect(strategist?.toolset).toContain('memory_read');
    });

    it('skips directories without config.yaml or ETHOS.md', async () => {
      await mkdir(join(testDir, 'empty-dir'));
      await writeFile(join(testDir, 'empty-dir', 'notes.txt'), 'nothing useful');

      const registry = new FilePersonalityRegistry();
      await registry.loadFromDirectory(testDir);
      expect(registry.list()).toHaveLength(0);
    });

    it('does not throw when directory does not exist', async () => {
      const registry = new FilePersonalityRegistry();
      await expect(registry.loadFromDirectory(join(testDir, 'nonexistent'))).resolves.not.toThrow();
    });

    it('uses mtime cache — second load skips unchanged personalities', async () => {
      const personalityDir = join(testDir, 'cached');
      await mkdir(personalityDir);
      await writeFile(join(personalityDir, 'config.yaml'), 'name: Cached\ndescription: Test\n');
      await writeFile(join(personalityDir, 'ETHOS.md'), '# Cached\n\nTest personality.');

      const registry = new FilePersonalityRegistry();
      await registry.loadFromDirectory(testDir);
      expect(registry.get('cached')?.name).toBe('Cached');

      // Mutate the in-memory config to detect if it gets overwritten
      registry.define({ id: 'cached', name: 'Mutated' });
      expect(registry.get('cached')?.name).toBe('Mutated');

      // Second load with same mtime → should NOT overwrite (cache hit)
      await registry.loadFromDirectory(testDir);
      expect(registry.get('cached')?.name).toBe('Mutated');
    });
  });

  describe('define / get / list / setDefault', () => {
    it('define and get round-trip', () => {
      const registry = new FilePersonalityRegistry();
      registry.define({ id: 'custom', name: 'Custom', toolset: ['read_file'] });
      expect(registry.get('custom')?.toolset).toContain('read_file');
    });

    it('list returns all defined personalities', () => {
      const registry = new FilePersonalityRegistry();
      registry.define({ id: 'a', name: 'A' });
      registry.define({ id: 'b', name: 'B' });
      expect(registry.list().map((p) => p.id)).toEqual(expect.arrayContaining(['a', 'b']));
    });

    it('setDefault changes getDefault', () => {
      const registry = new FilePersonalityRegistry();
      registry.define({ id: 'x', name: 'X' });
      registry.setDefault('x');
      expect(registry.getDefault().id).toBe('x');
    });

    it('setDefault throws for unknown id', () => {
      const registry = new FilePersonalityRegistry();
      expect(() => registry.setDefault('unknown')).toThrow();
    });
  });
});
