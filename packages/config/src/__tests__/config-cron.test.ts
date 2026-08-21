import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, readRawConfig } from '../index';

// `cron.trigger.*` / `cron.arming.*` — the cron-scheduler-seam config surface
// (plan/phases/cron-scheduler-seam.md). Nothing changes production behavior by
// default: a config with no `cron:` section at all must parse to
// `cfg.cron === undefined`, which the wiring layer (`buildCronTriggers`)
// treats identically to `{ trigger: { local: true, external: false } }`.

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

describe('cron config surface', () => {
  it("is absent when no cron: section is declared — today's behavior is unchanged", async () => {
    const cfg = await load([]);
    expect(cfg.cron).toBeUndefined();
  });

  it('parses cron.trigger.local and cron.trigger.external', async () => {
    const cfg = await load(['cron.trigger.local: false', 'cron.trigger.external: true']);
    expect(cfg.cron?.trigger).toEqual({ local: false, external: true });
  });

  it('parses cron.arming.backend and cron.arming.fireUrl', async () => {
    const cfg = await load([
      'cron.arming.backend: firecracker',
      'cron.arming.fireUrl: https://wake.example.com/cron/fire',
    ]);
    expect(cfg.cron?.arming).toEqual({
      backend: 'firecracker',
      fireUrl: 'https://wake.example.com/cron/fire',
    });
  });

  it('parses trigger and arming together', async () => {
    const cfg = await load([
      'cron.trigger.local: true',
      'cron.trigger.external: true',
      'cron.arming.backend: none',
    ]);
    expect(cfg.cron).toEqual({
      trigger: { local: true, external: true },
      arming: { backend: 'none' },
    });
  });
});
