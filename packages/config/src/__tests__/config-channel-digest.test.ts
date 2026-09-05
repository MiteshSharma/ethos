import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  type EthosConfig,
  ethosDir,
  observeModePlatforms,
  readRawConfig,
  writeConfig,
} from '../index';

// `channelDigest.*` — the ambient channel digest block
// (plan/phases/ambient-group-monitoring.md R3/R9/R10), plus
// `observeModePlatforms`, the startup check's only input.

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

describe('channelDigest config', () => {
  it('is absent when no channelDigest.* key is set', async () => {
    expect((await load([])).channelDigest).toBeUndefined();
  });

  it('parses every field', async () => {
    const cfg = await load([
      'channelDigest.enabled: true',
      'channelDigest.cron: 30 6 * * *',
      'channelDigest.deliverTo: inApp',
      'channelDigest.maxMessagesPerLane: 250',
      'channelDigest.costWarnUsdPerLane: 1.25',
    ]);
    expect(cfg.channelDigest).toEqual({
      enabled: true,
      cron: '30 6 * * *',
      deliverTo: 'inApp',
      maxMessagesPerLane: 250,
      costWarnUsdPerLane: 1.25,
    });
  });

  it('keeps a cron expression intact — spaces and asterisks and all', async () => {
    expect((await load(['channelDigest.cron: 0 8 * * 1-5'])).channelDigest?.cron).toBe(
      '0 8 * * 1-5',
    );
  });

  it('rejects a deliverTo outside the enum, naming what it expected', async () => {
    await expect(load(['channelDigest.deliverTo: sms'])).rejects.toThrow(
      /channelDigest\.deliverTo "sms".*'owner' or 'inApp'/,
    );
  });

  // Same failure `backup.keep` had: `parseInt`/`parseFloat` stop at the first
  // character they cannot use, so each of these would otherwise be accepted.
  it('rejects a message cap with trailing junk rather than parsing its prefix', async () => {
    await expect(load(['channelDigest.maxMessagesPerLane: 500 messages'])).rejects.toThrow(
      /maxMessagesPerLane "500 messages"/,
    );
  });

  it('rejects a fractional message cap', async () => {
    await expect(load(['channelDigest.maxMessagesPerLane: 1.5'])).rejects.toThrow(
      /maxMessagesPerLane/,
    );
  });

  it('rejects a zero message cap rather than reading it as "no digest"', async () => {
    await expect(load(['channelDigest.maxMessagesPerLane: 0'])).rejects.toThrow(/positive integer/);
  });

  it('rejects a cost threshold with trailing junk', async () => {
    await expect(load(['channelDigest.costWarnUsdPerLane: 0.5usd'])).rejects.toThrow(
      /costWarnUsdPerLane "0\.5usd"/,
    );
  });

  it('rejects a zero or negative cost threshold', async () => {
    await expect(load(['channelDigest.costWarnUsdPerLane: 0'])).rejects.toThrow(/positive number/);
    await expect(load(['channelDigest.costWarnUsdPerLane: -1'])).rejects.toThrow(
      /costWarnUsdPerLane/,
    );
  });

  // The setting is `costWarnUsdPerLane` on BOTH sides now — it was briefly
  // `maxCostUsdPerLane` here while `extensions/gateway` had already renamed
  // it, and `apps/ethos` translated between the two. That shim is gone. There
  // is deliberately no back-compat alias: `channelDigest.*` has never appeared
  // in a release, so no config on disk can be carrying the old name.
  it('names the new key, not the old one, when the value is out of range', async () => {
    await expect(load(['channelDigest.costWarnUsdPerLane: -1'])).rejects.toThrow(
      /Invalid channelDigest\.costWarnUsdPerLane "-1"\. Expected a positive number\./,
    );
  });

  // Unknown keys are not rejected anywhere in this loader — they are dropped.
  // So the old name does not throw; it is silently ignored, and the block it
  // sits in is still constructed (the `channelDigest.` prefix is what makes
  // the block present), just without a threshold.
  it('ignores the old maxCostUsdPerLane key rather than honouring or rejecting it', async () => {
    const cfg = await load(['channelDigest.maxCostUsdPerLane: 0.5']);
    expect(cfg.channelDigest).toEqual({});
    expect(cfg.channelDigest).not.toHaveProperty('costWarnUsdPerLane');
    expect(cfg.channelDigest).not.toHaveProperty('maxCostUsdPerLane');
  });

  it('treats a non-"true" enabled as false, like every other boolean here', async () => {
    expect((await load(['channelDigest.enabled: yes'])).channelDigest?.enabled).toBe(false);
    expect((await load(['channelDigest.enabled: true'])).channelDigest?.enabled).toBe(true);
  });

  it('round-trips through writeConfig', async () => {
    const cfg = await load([
      'channelDigest.enabled: true',
      'channelDigest.cron: 0 8 * * *',
      'channelDigest.deliverTo: owner',
      'channelDigest.maxMessagesPerLane: 500',
      'channelDigest.costWarnUsdPerLane: 0.5',
    ]);
    const storage = new InMemoryStorage();
    await writeConfig(storage, cfg, new InMemorySecretsResolver());
    const reloaded = await readRawConfig(storage);
    expect(reloaded?.channelDigest).toEqual(cfg.channelDigest);
    // Named explicitly: `toEqual` against the parse output alone would still
    // hold if BOTH sides had silently dropped the threshold.
    expect(reloaded?.channelDigest?.costWarnUsdPerLane).toBe(0.5);
  });
});

describe('observeModePlatforms', () => {
  it('is empty for a config that watches nothing', async () => {
    expect(observeModePlatforms(await load([]))).toEqual([]);
    expect(
      observeModePlatforms(
        await load(['whatsapp.0.id: wa', 'whatsapp.0.default_mode: mention_only']),
      ),
    ).toEqual([]);
  });

  it('names a platform put into observe mode', async () => {
    const cfg = await load(['whatsapp.0.id: wa', 'whatsapp.0.default_mode: observe']);
    expect(observeModePlatforms(cfg)).toEqual(['whatsapp']);
  });

  it('names each platform once, however many of its bots observe', async () => {
    const cfg = await load([
      'whatsapp.0.id: wa-1',
      'whatsapp.0.default_mode: observe',
      'whatsapp.1.id: wa-2',
      'whatsapp.1.default_mode: observe',
    ]);
    expect(observeModePlatforms(cfg)).toEqual(['whatsapp']);
  });
});
