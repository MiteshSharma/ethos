// Item 1 — `kanban.maxInProgress` / `kanban.maxInProgressPerProfile`: board WIP caps.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../index';

describe('kanban WIP limit config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

  it('parses both caps', async () => {
    const cfg = await load(
      [...base, 'kanban.maxInProgress: 5', 'kanban.maxInProgressPerProfile: 2'].join('\n'),
    );
    expect(cfg?.kanban).toEqual({ maxInProgress: 5, maxInProgressPerProfile: 2 });
  });

  it('parses a single cap on its own', async () => {
    const cfg = await load([...base, 'kanban.maxInProgressPerProfile: 1'].join('\n'));
    expect(cfg?.kanban).toEqual({ maxInProgressPerProfile: 1 });
  });

  it('drops a non-positive or non-numeric cap and keeps the rest', async () => {
    const cfg = await load(
      [...base, 'kanban.maxInProgress: 0', 'kanban.maxInProgressPerProfile: 3'].join('\n'),
    );
    expect(cfg?.kanban).toEqual({ maxInProgressPerProfile: 3 });
    const bad = await load([...base, 'kanban.maxInProgress: lots'].join('\n'));
    expect(bad?.kanban).toBeUndefined();
  });

  it('does not collide with the kanbanPoll block', async () => {
    const cfg = await load(
      [...base, 'kanban.maxInProgress: 4', 'kanbanPoll.intervalMs: 7000'].join('\n'),
    );
    expect(cfg?.kanban).toEqual({ maxInProgress: 4 });
    expect(cfg?.kanbanPoll).toEqual({ intervalMs: 7000 });
  });

  it('leaves kanban undefined when no keys are present (uncapped)', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.kanban).toBeUndefined();
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'sk',
      personality: 'researcher',
      kanban: { maxInProgress: 6, maxInProgressPerProfile: 2 },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.kanban).toEqual(original.kanban);
  });
});
