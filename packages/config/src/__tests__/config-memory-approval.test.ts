import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, readRawConfig, writeConfig } from '../index';

// memory-lifecycle L2 — memoryApproval.* config block.
describe('memoryApproval config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: anthropic', 'model: claude-opus-4-7', 'apiKey: sk', 'personality: p'];

  it('leaves memoryApproval undefined when no keys are present (default off)', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.memoryApproval).toBeUndefined();
  });

  it('parses mode / cap / ttlDays', async () => {
    const cfg = await load(
      [
        ...base,
        'memoryApproval.mode: automated',
        'memoryApproval.cap: 50',
        'memoryApproval.ttlDays: 14',
      ].join('\n'),
    );
    expect(cfg?.memoryApproval).toEqual({ mode: 'automated', cap: 50, ttlDays: 14 });
  });

  it('parses mode: all', async () => {
    const cfg = await load([...base, 'memoryApproval.mode: all'].join('\n'));
    expect(cfg?.memoryApproval).toEqual({ mode: 'all' });
  });

  it('rejects an invalid mode', async () => {
    await expect(load([...base, 'memoryApproval.mode: yolo'].join('\n'))).rejects.toThrow(
      /Invalid memoryApproval\.mode/,
    );
  });

  it('rejects a non-positive cap', async () => {
    await expect(load([...base, 'memoryApproval.cap: 0'].join('\n'))).rejects.toThrow(
      /Invalid memoryApproval\.cap/,
    );
  });

  it('round-trips through writeConfig + parse', async () => {
    const storage = new InMemoryStorage();
    const config: EthosConfig = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'p',
      memoryApproval: { mode: 'automated', cap: 200, ttlDays: 30 },
    };
    await writeConfig(storage, config, new InMemorySecretsResolver());
    const reparsed = await readRawConfig(storage);
    expect(reparsed?.memoryApproval).toEqual({ mode: 'automated', cap: 200, ttlDays: 30 });
  });
});
