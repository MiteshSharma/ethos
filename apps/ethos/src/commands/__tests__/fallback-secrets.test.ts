import { join } from 'node:path';
import {
  type EthosConfig,
  ethosDir,
  type ProviderConfig,
  readRawConfig,
  secretRefFromValue,
  writeConfig,
} from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import type { SecretsResolver, Storage } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runFallback } from '../fallback';

// `ethos fallback` reaches for the process-wide Storage / SecretsResolver.
// Swap both for in-memory doubles so config.yaml and the vault are inspectable.
const wiring = vi.hoisted(() => ({}) as { storage?: Storage; secrets?: SecretsResolver });

vi.mock('../../wiring', () => ({
  getStorage: () => wiring.storage,
  getSecretsResolver: async () => wiring.secrets,
}));

// Assembled rather than written literally so the source doesn't carry a bare
// `${secrets:…}` string (Biome's noTemplateCurlyInString).
function secretRef(path: string): string {
  return ['${', 'secrets:', path, '}'].join('');
}

const BASE = {
  schemaVersion: 1,
  provider: 'anthropic',
  model: 'claude-opus-4-7',
  apiKey: 'sk-primary',
  personality: 'researcher',
} satisfies EthosConfig;

async function seed(
  providers: ProviderConfig[],
  secrets: SecretsResolver = new InMemorySecretsResolver(),
) {
  const storage = new InMemoryStorage();
  await writeConfig(storage, { ...BASE, providers }, secrets);
  wiring.storage = storage;
  wiring.secrets = secrets;
  return { storage, secrets };
}

async function chainOf(storage: Storage): Promise<ProviderConfig[]> {
  return (await readRawConfig(storage))?.providers ?? [];
}

describe('ethos fallback removes vault material with the config write first', () => {
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

  it('drops the removed entry’s ref and leaves the survivor resolvable', async () => {
    const { storage, secrets } = await seed([
      { provider: 'openrouter', apiKey: 'sk-or-1' },
      { provider: 'ollama', apiKey: 'sk-ol-2' },
    ]);
    const [first, second] = await chainOf(storage);
    const removedRef = first && secretRefFromValue(first.apiKey);
    const survivorRef = second && secretRefFromValue(second.apiKey);
    expect(removedRef).toBeTruthy();

    await runFallback(['remove', '1']);

    expect(await secrets.list()).not.toContain(removedRef);
    expect(await secrets.list()).toContain(survivorRef);
    expect(await chainOf(storage)).toEqual([
      { provider: 'ollama', apiKey: secretRef(survivorRef ?? '') },
    ]);
  });

  it('keeps the config write ahead of the delete — a failed write leaves the vault intact', async () => {
    const { storage, secrets } = await seed([
      { provider: 'openrouter', apiKey: 'sk-or-1' },
      { provider: 'ollama', apiKey: 'sk-ol-2' },
    ]);
    const before = await secrets.list();
    vi.spyOn(storage, 'write').mockRejectedValue(new Error('disk full'));

    await expect(runFallback(['remove', '1'])).rejects.toThrow('disk full');

    // Nothing was deleted: config still references every ref it did before.
    expect(await secrets.list()).toEqual(before);
  });

  it('keeps a ref a surviving entry still points at', async () => {
    // `add` mints `providers/<chain.length>/<provider>/apiKey`, so a removal
    // followed by an add can hand two entries the same ref.
    const secrets = new InMemorySecretsResolver();
    const storage = new InMemoryStorage();
    const shared = 'providers/1/openrouter/apiKey';
    await secrets.set(shared, 'sk-shared');
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      [
        'schemaVersion: 1',
        'provider: anthropic',
        'model: claude-opus-4-7',
        `apiKey: ${secretRef('providers/anthropic/apiKey')}`,
        'personality: researcher',
        'providers.0.provider: openrouter',
        `providers.0.apiKey: ${secretRef(shared)}`,
        'providers.1.provider: openrouter',
        `providers.1.apiKey: ${secretRef(shared)}`,
      ].join('\n'),
    );
    wiring.storage = storage;
    wiring.secrets = secrets;

    await runFallback(['remove', '1']);

    expect(await secrets.list()).toContain(shared);
    expect(await chainOf(storage)).toEqual([{ provider: 'openrouter', apiKey: secretRef(shared) }]);
  });

  it('still removes the entry when the vault delete fails, and says so', async () => {
    const secrets = new InMemorySecretsResolver() as SecretsResolver;
    const { storage } = await seed([{ provider: 'openrouter', apiKey: 'sk-or-1' }], secrets);
    const [first] = await chainOf(storage);
    const removedRef = first && secretRefFromValue(first.apiKey);
    vi.spyOn(secrets, 'delete').mockRejectedValue(new Error('vault is read-only'));

    await expect(runFallback(['remove', '1'])).resolves.toBeUndefined();

    expect(await chainOf(storage)).toEqual([]);
    const warning = logged.join('\n');
    expect(warning).toContain('vault is read-only');
    expect(warning).toContain(`ethos secrets remove ${removedRef}`);
  });

  it('clear drops every ref, and surfaces a failed delete instead of swallowing it', async () => {
    const secrets = new InMemorySecretsResolver() as SecretsResolver;
    const { storage } = await seed(
      [
        { provider: 'openrouter', apiKey: 'sk-or-1' },
        { provider: 'ollama', apiKey: 'sk-ol-2' },
      ],
      secrets,
    );
    const chain = await chainOf(storage);
    const refs = chain.map((p) => secretRefFromValue(p.apiKey));

    await runFallback(['clear']);

    expect(await chainOf(storage)).toEqual([]);
    for (const ref of refs) expect(await secrets.list()).not.toContain(ref);

    // Same again, with the vault refusing.
    const { storage: storage2 } = await seed(
      [{ provider: 'openrouter', apiKey: 'sk-or-1' }],
      secrets,
    );
    const [only] = await chainOf(storage2);
    const ref = only && secretRefFromValue(only.apiKey);
    vi.spyOn(secrets, 'delete').mockRejectedValue(new Error('vault is read-only'));

    await expect(runFallback(['clear'])).resolves.toBeUndefined();

    expect(await chainOf(storage2)).toEqual([]);
    const warning = logged.join('\n');
    expect(warning).toContain('vault is read-only');
    expect(warning).toContain(`ethos secrets remove ${ref}`);
  });
});
