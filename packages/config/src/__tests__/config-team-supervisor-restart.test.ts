// Item 4 — `teamSupervisor.restartLoopGuard`: the rolling-window brake on
// member auto-restart. Named `teamSupervisor`, not `gateway`: the gateway
// process does not restart itself.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../index';

describe('team-supervisor restart-loop-guard config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

  it('parses both bounds', async () => {
    const cfg = await load(
      [
        ...base,
        'teamSupervisor.restartLoopGuard.maxRestarts: 3',
        'teamSupervisor.restartLoopGuard.windowSeconds: 120',
      ].join('\n'),
    );
    expect(cfg?.teamSupervisor).toEqual({
      restartLoopGuard: { maxRestarts: 3, windowSeconds: 120 },
    });
  });

  it('parses a single bound on its own', async () => {
    const cfg = await load([...base, 'teamSupervisor.restartLoopGuard.maxRestarts: 2'].join('\n'));
    expect(cfg?.teamSupervisor).toEqual({ restartLoopGuard: { maxRestarts: 2 } });
  });

  it('drops out-of-range values and keeps the rest', async () => {
    const cfg = await load(
      [
        ...base,
        'teamSupervisor.restartLoopGuard.maxRestarts: 0',
        'teamSupervisor.restartLoopGuard.windowSeconds: 30',
      ].join('\n'),
    );
    expect(cfg?.teamSupervisor).toEqual({ restartLoopGuard: { windowSeconds: 30 } });

    const bad = await load(
      [...base, 'teamSupervisor.restartLoopGuard.windowSeconds: forever'].join('\n'),
    );
    expect(bad?.teamSupervisor).toBeUndefined();
  });

  it('leaves teamSupervisor undefined when no keys are present', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.teamSupervisor).toBeUndefined();
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'sk',
      personality: 'researcher',
      teamSupervisor: { restartLoopGuard: { maxRestarts: 8, windowSeconds: 300 } },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.teamSupervisor).toEqual(original.teamSupervisor);
  });
});
