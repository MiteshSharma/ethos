import { join } from 'node:path';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import { SkillsLibrary } from '@ethosagent/skills';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { PersonalitiesService } from '../../services/personalities.service';
import { makeStubPersonalityRegistry } from '../test-helpers';

// Service tests cover both the repository (via real ETHOS.md reads from
// InMemoryStorage) and the wire-shape mapping.

const DATA = '/data';

describe('PersonalitiesService', () => {
  function makeService(opts: { personalities: import('@ethosagent/types').PersonalityConfig[] }) {
    const registry = makeStubPersonalityRegistry(opts.personalities, DATA);
    const library = new SkillsLibrary({ dataDir: DATA });
    return new PersonalitiesService({ personalities: registry, library });
  }

  it('list maps PersonalityConfig → wire shape and includes defaultId', () => {
    const service = makeService({
      personalities: [
        {
          id: 'researcher',
          name: 'Researcher',
          description: 'curious + careful',
          model: 'claude-opus-4-7',
          memoryScope: 'global',
          // ethosFile lives outside the user dir → built-in
          ethosFile: '/usr/share/ethos/personalities/researcher/ETHOS.md',
        },
      ],
    });
    const result = service.list();
    expect(result.defaultId).toBe('researcher');
    expect(result.personalities).toHaveLength(1);
    const p = result.personalities[0];
    if (!p) throw new Error('expected one personality');
    expect(p.id).toBe('researcher');
    expect(p.builtin).toBe(true);
    // Server-internal fields are stripped
    expect('ethosFile' in p).toBe(false);
    expect('skillsDirs' in p).toBe(false);
  });

  it('marks user personalities as builtin: false based on ethosFile path', () => {
    const userEthosFile = join(DATA, 'personalities', 'custom', 'ETHOS.md');
    const service = makeService({
      personalities: [
        { id: 'custom', name: 'Custom', ethosFile: userEthosFile },
        // No ethosFile → treated as built-in (config-only personalities are built-ins by default)
        { id: 'builtin', name: 'Built-in' },
      ],
    });
    const result = service.list();
    const byId = Object.fromEntries(result.personalities.map((p) => [p.id, p]));
    expect(byId.custom?.builtin).toBe(false);
    expect(byId.builtin?.builtin).toBe(true);
  });

  it('get returns personality + reads ETHOS.md body from disk', async () => {
    const storage = new InMemoryStorage();
    const ethosPath = join(DATA, 'personalities', 'researcher', 'ETHOS.md');
    await storage.mkdir(join(DATA, 'personalities', 'researcher'));
    await storage.write(ethosPath, '# Researcher\n\nI am a careful researcher.\n');

    const registry = new FilePersonalityRegistry(storage, DATA);
    registry.define({ id: 'researcher', name: 'Researcher', ethosFile: ethosPath });
    registry.setDefault('researcher');
    const library = new SkillsLibrary({ dataDir: DATA, storage });
    const service = new PersonalitiesService({ personalities: registry, library });

    const result = await service.get('researcher');
    expect(result.personality.id).toBe('researcher');
    expect(result.ethosMd).toContain('I am a careful researcher.');
    // ethosFile under DATA/personalities/ → user-owned → builtin: false
    expect(result.personality.builtin).toBe(false);
  });

  it('get throws PERSONALITY_NOT_FOUND for unknown ids', async () => {
    const service = makeService({ personalities: [] });
    await expect(service.get('nope')).rejects.toMatchObject({ code: 'PERSONALITY_NOT_FOUND' });
  });

  it('get returns empty ethosMd when file is missing', async () => {
    const service = makeService({
      personalities: [
        {
          id: 'researcher',
          name: 'Researcher',
          ethosFile: join(DATA, 'personalities', 'researcher', 'ETHOS.md'),
        },
      ],
    });
    const result = await service.get('researcher');
    expect(result.ethosMd).toBe('');
  });
});
