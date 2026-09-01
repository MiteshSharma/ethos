// Item 9 — docker execution-backend resource caps (`execution.docker.cpu` /
// `execution.docker.diskMb`).

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../index';

describe('execution.docker config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

  it('parses cpu and diskMb', async () => {
    const cfg = await load(
      [...base, 'execution.docker.cpu: 4', 'execution.docker.diskMb: 20480'].join('\n'),
    );
    expect(cfg?.execution).toEqual({ docker: { cpu: 4, diskMb: 20_480 } });
  });

  it('keeps a fractional cpu but floors diskMb', async () => {
    const cfg = await load(
      [...base, 'execution.docker.cpu: 1.5', 'execution.docker.diskMb: 2048.9'].join('\n'),
    );
    expect(cfg?.execution).toEqual({ docker: { cpu: 1.5, diskMb: 2048 } });
  });

  it('drops non-positive and non-numeric values', async () => {
    const cfg = await load(
      [...base, 'execution.docker.cpu: 0', 'execution.docker.diskMb: plenty'].join('\n'),
    );
    expect(cfg?.execution).toBeUndefined();
  });

  it('keeps the surviving field when only one is out of range', async () => {
    const cfg = await load(
      [...base, 'execution.docker.cpu: -2', 'execution.docker.diskMb: 512'].join('\n'),
    );
    expect(cfg?.execution).toEqual({ docker: { diskMb: 512 } });
  });

  it('leaves execution undefined when no keys are present', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.execution).toBeUndefined();
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'sk',
      personality: 'researcher',
      execution: { docker: { cpu: 3, diskMb: 10_240 } },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.execution).toEqual(original.execution);
  });
});
