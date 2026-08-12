import { join } from 'node:path';
import {
  ethosDir,
  type KeyProfile,
  readKeys,
  rotationSecretRef,
  writeKeys,
} from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import type { SecretsResolver, Storage } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runKeys } from '../keys';

// `ethos keys remove` reaches for the process-wide Storage / SecretsResolver.
// Swap both for in-memory doubles so the pool and the vault are inspectable.
// `vi.hoisted` runs before this file's imports, so the doubles are installed by
// each test's `seed()` rather than constructed here.
const wiring = vi.hoisted(() => ({}) as { storage?: Storage; secrets?: SecretsResolver });

vi.mock('../../wiring', () => ({
  getStorage: () => wiring.storage,
  getSecretsResolver: async () => wiring.secrets,
}));

async function seed(keys: KeyProfile[], secrets: SecretsResolver = new InMemorySecretsResolver()) {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await writeKeys(storage, keys, secrets);
  wiring.storage = storage;
  wiring.secrets = secrets;
  return { storage, secrets };
}

describe('ethos keys remove deletes the removed key from the vault', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops the removed profile’s ref and leaves the survivors resolvable', async () => {
    const { storage, secrets } = await seed([
      { apiKey: 'PLAIN-primary', priority: 100, label: 'primary' },
      { apiKey: 'PLAIN-backup', priority: 50, label: 'backup' },
    ]);
    const [primary] = await readKeys(storage);
    const removedRef = primary && rotationSecretRef(primary);
    expect(removedRef).toBeTruthy();

    await runKeys(['remove', '1']);

    expect(await secrets.list()).not.toContain(removedRef);
    expect(await readKeys(storage, secrets)).toEqual([
      { apiKey: 'PLAIN-backup', priority: 50, label: 'backup' },
    ]);
  });

  it('keeps a ref two profiles share — refs are content-addressed', async () => {
    const { storage, secrets } = await seed([
      { apiKey: 'SAME-KEY', priority: 100, label: 'a' },
      { apiKey: 'SAME-KEY', priority: 10, label: 'b' },
    ]);
    // Same value → same ref → one vault entry backing both profiles.
    expect(await secrets.list()).toHaveLength(1);

    await runKeys(['remove', '1']);

    expect(await secrets.list()).toHaveLength(1);
    expect(await readKeys(storage, secrets)).toEqual([
      { apiKey: 'SAME-KEY', priority: 10, label: 'b' },
    ]);
  });

  it('removes a legacy plaintext profile without touching the vault', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    const del = vi.spyOn(secrets, 'delete');
    await storage.mkdir(ethosDir());
    // Pre-externalization keys.json: values on disk, nothing in the vault.
    await storage.write(
      join(ethosDir(), 'keys.json'),
      JSON.stringify([
        { apiKey: 'sk-legacy-a', priority: 100 },
        { apiKey: 'sk-legacy-b', priority: 50 },
      ]),
    );
    wiring.storage = storage;
    wiring.secrets = secrets;

    await expect(runKeys(['remove', '1'])).resolves.toBeUndefined();

    expect(del).not.toHaveBeenCalled();
    // The survivor is externalized by the rewrite, as `writeKeys` always does.
    expect(await readKeys(storage, secrets)).toEqual([{ apiKey: 'sk-legacy-b', priority: 50 }]);
  });

  it('still removes the profile when the vault delete fails, and says so', async () => {
    const secrets = new InMemorySecretsResolver() as SecretsResolver;
    const { storage } = await seed(
      [
        { apiKey: 'PLAIN-primary', priority: 100 },
        { apiKey: 'PLAIN-backup', priority: 50 },
      ],
      secrets,
    );
    const [primary] = await readKeys(storage);
    const removedRef = primary && rotationSecretRef(primary);
    vi.spyOn(secrets, 'delete').mockRejectedValue(new Error('vault is read-only'));

    await expect(runKeys(['remove', '1'])).resolves.toBeUndefined();

    // keys.json is the source of truth: the removal stands.
    expect(await readKeys(storage, secrets)).toEqual([{ apiKey: 'PLAIN-backup', priority: 50 }]);
    // ...and the orphaned material is surfaced, not swallowed.
    const warning = logged.join('\n');
    expect(warning).toContain('vault is read-only');
    expect(warning).toContain(`ethos secrets remove ${removedRef}`);
  });
});
