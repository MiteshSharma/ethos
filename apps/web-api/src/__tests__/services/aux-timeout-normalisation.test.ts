import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
import { ConfigService } from '../../services/config.service';

// T15, second read path — plan/phases/settings-navigation.md §8 "0a-1".
// `ConfigService.get` reads `auxiliary.{asr,tts}.timeout` out of the RAW
// passthrough map, not out of the typed `EthosConfig.auxiliary`, so the
// parse-site shim does not reach it. Same table as
// packages/config/src/__tests__/aux-timeout-normalisation.test.ts: if the two
// read paths ever disagree, the Settings page shows a number the runtime is not
// using.
//
// Deleted in the same commit that removes the shim (`aux-timeout-shim-removal`).

const DATA = '/data';

const BASE = [
  'provider: anthropic',
  'model: claude-opus-4-7',
  'apiKey: sk-anthropic-1234567890abcdef',
  'personality: researcher',
];

describe('ConfigService — auxiliary timeout normalisation', () => {
  let storage: InMemoryStorage;
  let service: ConfigService;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(DATA);
    const repo = new ConfigRepository({ dataDir: DATA, storage, secrets });
    service = new ConfigService({ config: repo, secrets });
  });

  async function seed(lines: string[]): Promise<void> {
    await storage.write(join(DATA, 'config.yaml'), [...BASE, ...lines].join('\n'));
  }

  for (const [raw, expected] of [
    [120, 120],
    [3600, 3600],
    [3601, 4],
    [30_000, 30],
    [600_000, 600],
  ] as const) {
    it(`reads a stored ${raw} as ${expected} on both timeouts`, async () => {
      await seed([`auxiliary.asr.timeout: ${raw}`, `auxiliary.tts.timeout: ${raw}`]);
      const config = await service.get();
      expect(config.voiceSttTimeoutMs).toBe(expected);
      expect(config.voiceTtsTimeoutMs).toBe(expected);
    });
  }

  it('leaves the roster alone — it was always seconds', async () => {
    await seed([
      'voice.stt.providers.fast.provider: command-stt',
      'voice.stt.providers.fast.timeout: 30000',
    ]);
    const config = await service.get();
    expect(config.voiceSttProviders.fast?.timeout).toBe(30_000);
  });
});
