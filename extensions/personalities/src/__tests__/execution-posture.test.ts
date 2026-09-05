import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { Storage } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { FilePersonalityRegistry } from '../index';

// `PersonalityConfig.execution` — the execution POSTURE (local / docker / ssh
// / none). Identity, and therefore on the personality; the ssh TARGET stays in
// the operator's ~/.ethos/config.yaml. These cover the loader's parse,
// validation, and config.yaml round-trip only.

const DATA = '/data';
const DIR = join(DATA, 'personalities');

async function seed(storage: Storage, id: string, config: string): Promise<void> {
  const dir = join(DIR, id);
  await storage.mkdir(dir);
  await storage.write(join(dir, 'config.yaml'), config);
  await storage.write(join(dir, 'SOUL.md'), `# ${id}\n`);
  await storage.write(join(dir, 'toolset.yaml'), '- terminal\n');
}

describe('PersonalityConfig.execution — loader', () => {
  let storage: InMemoryStorage;
  let registry: FilePersonalityRegistry;

  beforeEach(() => {
    storage = new InMemoryStorage();
    registry = new FilePersonalityRegistry(storage, DATA);
  });

  it.each(['local', 'docker', 'ssh', 'none'] as const)('accepts execution: %s', async (posture) => {
    await seed(storage, 'hands', `name: Hands\nexecution: ${posture}\n`);
    await registry.loadFromDirectory(DIR);
    expect(registry.get('hands')?.execution).toBe(posture);
  });

  it('rejects an unknown posture, naming the key and the allowed values', async () => {
    await seed(storage, 'hands', 'name: Hands\nexecution: remote\n');
    await expect(registry.loadFromDirectory(DIR)).rejects.toThrow(
      /Invalid execution: "remote"\. Expected one of: local, docker, ssh, none/,
    );
  });

  it('leaves execution undefined when the key is absent — no default posture', async () => {
    await seed(storage, 'plain', 'name: Plain\n');
    await registry.loadFromDirectory(DIR);
    const config = registry.get('plain');
    expect(config).toBeDefined();
    expect(config?.execution).toBeUndefined();
    expect('execution' in (config ?? {})).toBe(false);
  });

  it('round-trips through update(): the literal survives in config.yaml and on re-load', async () => {
    await seed(storage, 'remote-hands', 'name: RemoteHands\nexecution: ssh\n');
    await registry.loadFromDirectory(DIR);
    expect(registry.get('remote-hands')?.execution).toBe('ssh');

    // Patch an unrelated field — a posture the author declared must not be
    // dropped by an edit that never mentions it.
    await registry.update('remote-hands', { description: 'Runs on the build box' });

    // Assert the literal on BOTH sides: the serialized text and the re-load.
    // A bare object comparison passes when both sides drop the field.
    const raw = await storage.read(join(DIR, 'remote-hands', 'config.yaml'));
    expect(raw).toContain('execution: ssh');

    const fresh = new FilePersonalityRegistry(storage, DATA);
    await fresh.loadFromDirectory(DIR);
    expect(fresh.get('remote-hands')?.execution).toBe('ssh');
    expect(fresh.get('remote-hands')?.description).toBe('Runs on the build box');
  });
});
