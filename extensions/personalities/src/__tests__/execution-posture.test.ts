import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { Storage } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { FilePersonalityRegistry } from '../index';

// `PersonalityConfig.execution` — the execution REQUIREMENT (`remote` /
// `none`). Identity, and therefore on the personality; the transport AND the
// target stay in the operator's ~/.ethos/config.yaml. These cover the loader's
// parse, validation, retired-literal rejection, and config.yaml round-trip.

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

  it.each(['remote', 'none'] as const)('accepts execution: %s', async (requirement) => {
    await seed(storage, 'hands', `name: Hands\nexecution: ${requirement}\n`);
    await registry.loadFromDirectory(DIR);
    expect(registry.get('hands')?.execution).toBe(requirement);
  });

  it('rejects an unknown requirement, naming the key and the allowed values', async () => {
    await seed(storage, 'hands', 'name: Hands\nexecution: sideways\n');
    await expect(registry.loadFromDirectory(DIR)).rejects.toThrow(
      /Invalid execution: "sideways"\. Expected one of: remote, none/,
    );
  });

  // The three retired transport literals shipped one commit before this change,
  // so the population is small but not provably zero. Each is REJECTED rather
  // than translated: `ssh` → `remote` is a translation anyone would call safe,
  // and accepting it silently is how a contract shift goes unread. The error is
  // the whole migration, so it has to name the replacement.
  it('rejects execution: ssh, naming `remote` as the replacement', async () => {
    await seed(storage, 'hands', 'name: Hands\nexecution: ssh\n');
    await expect(registry.loadFromDirectory(DIR)).rejects.toThrow(
      /no longer accepted.*REQUIREMENT, not a transport.*execution: remote.*execution\.ssh\.\*/s,
    );
  });

  it.each(['docker', 'local'] as const)(
    'rejects execution: %s, sending the choice to the operator',
    async (retired) => {
      await seed(storage, 'hands', `name: Hands\nexecution: ${retired}\n`);
      await expect(registry.loadFromDirectory(DIR)).rejects.toThrow(
        /no longer accepted.*operator's choice, not the personality's.*Expected one of: remote, none/s,
      );
    },
  );

  it('leaves execution undefined when the key is absent — no default posture', async () => {
    await seed(storage, 'plain', 'name: Plain\n');
    await registry.loadFromDirectory(DIR);
    const config = registry.get('plain');
    expect(config).toBeDefined();
    expect(config?.execution).toBeUndefined();
    expect('execution' in (config ?? {})).toBe(false);
  });

  it('round-trips through update(): the literal survives in config.yaml and on re-load', async () => {
    await seed(storage, 'remote-hands', 'name: RemoteHands\nexecution: remote\n');
    await registry.loadFromDirectory(DIR);
    expect(registry.get('remote-hands')?.execution).toBe('remote');

    // Patch an unrelated field — a posture the author declared must not be
    // dropped by an edit that never mentions it.
    await registry.update('remote-hands', { description: 'Runs on the build box' });

    // Assert the literal on BOTH sides: the serialized text and the re-load.
    // A bare object comparison passes when both sides drop the field.
    const raw = await storage.read(join(DIR, 'remote-hands', 'config.yaml'));
    expect(raw).toContain('execution: remote');

    const fresh = new FilePersonalityRegistry(storage, DATA);
    await fresh.loadFromDirectory(DIR);
    expect(fresh.get('remote-hands')?.execution).toBe('remote');
    expect(fresh.get('remote-hands')?.description).toBe('Runs on the build box');
  });
});
