import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isEthosError } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PersonalityRepository } from '../../repositories/personality.repository';
import { PersonalitiesService } from '../../services/personalities.service';
import { makeStubPersonalityRegistry } from '../test-helpers';

// Service tests cover both the repository (via real ETHOS.md reads from a
// tmp dir) and the wire-shape mapping.

describe('PersonalitiesService', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-personalities-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeService(opts: { personalities: import('@ethosagent/types').PersonalityConfig[] }) {
    const registry = makeStubPersonalityRegistry(opts.personalities);
    const repo = new PersonalityRepository({ registry, userPersonalitiesDir: dir });
    return new PersonalitiesService({ personalities: repo });
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
    const userEthosFile = join(dir, 'personalities', 'custom', 'ETHOS.md');
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
    const personalityDir = join(dir, 'personalities', 'researcher');
    await mkdir(personalityDir, { recursive: true });
    const ethosPath = join(personalityDir, 'ETHOS.md');
    await writeFile(ethosPath, '# Researcher\n\nI am a careful researcher.\n');

    const service = makeService({
      personalities: [{ id: 'researcher', name: 'Researcher', ethosFile: ethosPath }],
    });

    const result = await service.get('researcher');
    expect(result.personality.id).toBe('researcher');
    expect(result.ethosMd).toContain('I am a careful researcher.');
    // User-dir → builtin: false
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
          ethosFile: join(dir, 'personalities', 'researcher', 'ETHOS.md'),
        },
      ],
    });
    const result = await service.get('researcher');
    expect(result.ethosMd).toBe('');
  });
});
