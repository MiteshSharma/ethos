import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, readRawConfig, writeConfig } from '../index';

// `backup.*` — the scheduled-snapshot block (plan agent-state-backup §3, T4).
//
// The block is absent from every config written before this shipped, so the
// "no keys at all" case is the one that matters most: `backup` must parse to
// `undefined` and let the wiring layer apply the defaults. Scope NAMES are
// deliberately not validated here — the roster lives in `@ethosagent/wiring`,
// which this package must not depend on — but `keep` is a plain number range
// and is this package's job.

async function load(lines: string[]): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(
    join(ethosDir(), 'config.yaml'),
    ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: researcher', ...lines].join(
      '\n',
    ),
  );
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

describe('backup config', () => {
  it('is absent when no backup.* key is set', async () => {
    const cfg = await load([]);
    expect(cfg.backup).toBeUndefined();
  });

  it('parses every field', async () => {
    const cfg = await load([
      'backup.enabled: false',
      'backup.cron: 0 5 * * *',
      'backup.scope: identity, state',
      'backup.keep: 3',
      'backup.dir: /mnt/snapshots',
    ]);
    expect(cfg.backup).toEqual({
      enabled: false,
      cron: '0 5 * * *',
      scope: ['identity', 'state'],
      keep: 3,
      dir: '/mnt/snapshots',
    });
  });

  it('keeps a cron expression intact — spaces and asterisks and all', async () => {
    const cfg = await load(['backup.cron: 30 2 * * 0']);
    expect(cfg.backup?.cron).toBe('30 2 * * 0');
  });

  it('rejects a non-positive keep', async () => {
    await expect(load(['backup.keep: 0'])).rejects.toThrow(/backup\.keep/);
  });

  it('rejects a non-numeric keep', async () => {
    await expect(load(['backup.keep: seven'])).rejects.toThrow(/backup\.keep/);
  });

  // `Number.parseInt` stops at the first non-digit, so each of these used to be
  // silently accepted by a message that promises a positive integer.
  it('rejects a keep with trailing junk rather than parsing its prefix', async () => {
    await expect(load(['backup.keep: 7days'])).rejects.toThrow(/backup\.keep "7days"/);
  });

  it('rejects a fractional keep rather than truncating it', async () => {
    await expect(load(['backup.keep: 1.5'])).rejects.toThrow(/backup\.keep "1\.5"/);
  });

  it('rejects a negative keep', async () => {
    await expect(load(['backup.keep: -3'])).rejects.toThrow(/backup\.keep/);
  });

  it('rejects a keep past the safe-integer range', async () => {
    await expect(load(['backup.keep: 9007199254740993'])).rejects.toThrow(/backup\.keep/);
  });

  // `backup.enabled` follows this file's boolean convention (`=== 'true'`),
  // shared with the other ~49 flags: anything else is false.
  it('treats a non-"true" enabled as false, like every other boolean here', async () => {
    expect((await load(['backup.enabled: yes'])).backup?.enabled).toBe(false);
    expect((await load(['backup.enabled: true'])).backup?.enabled).toBe(true);
  });

  it('does not validate scope names — that roster belongs to the backup engine', async () => {
    const cfg = await load(['backup.scope: identity, nonsense']);
    expect(cfg.backup?.scope).toEqual(['identity', 'nonsense']);
  });

  it('round-trips through writeConfig', async () => {
    const cfg = await load([
      'backup.enabled: true',
      'backup.cron: 0 4 * * *',
      'backup.scope: identity,state',
      'backup.keep: 7',
      'backup.dir: /mnt/snapshots',
    ]);
    const storage = new InMemoryStorage();
    await writeConfig(storage, cfg, new InMemorySecretsResolver());
    const reloaded = await readRawConfig(storage);
    expect(reloaded?.backup).toEqual(cfg.backup);
  });
});
