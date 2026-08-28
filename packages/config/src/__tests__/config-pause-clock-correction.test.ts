// The `pauseClockCorrection.<field>` operator block — the resume-side twin of
// `idleWatcher` (plan/phases/clock-tolerance-pass.md §7). On a snapshotting host
// the guest clock stops while the VM is paused, so on resume every staleness
// gate reads the pause as downtime; this block is how an operator turns the
// correction on.
//
// The load-bearing property pinned here is DEFAULT-OFF BY OMISSION: an absent
// block must leave `pauseClockCorrection` undefined, so every existing
// deployment (bare metal, docker, `pnpm dev`) behaves exactly as it did before
// the feature existed.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../index';

async function load(yaml: string) {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  return readRawConfig(storage);
}

const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

describe('pauseClockCorrection config block', () => {
  it('is absent entirely when the block is not set', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.pauseClockCorrection).toBeUndefined();
  });

  it('parses the full block', async () => {
    const cfg = await load(
      [
        ...base,
        'pauseClockCorrection.enabled: true',
        'pauseClockCorrection.thresholdMs: 90000',
      ].join('\n'),
    );
    expect(cfg?.pauseClockCorrection).toEqual({ enabled: true, thresholdMs: 90_000 });
  });

  it('accepts a partial block and leaves the threshold to the detector default', async () => {
    const cfg = await load([...base, 'pauseClockCorrection.enabled: true'].join('\n'));
    expect(cfg?.pauseClockCorrection).toEqual({ enabled: true });
  });

  it('enabled with a junk value is false, never true', async () => {
    for (const raw of ['yes', 'TRUE', '1', 'on', 'flase']) {
      const cfg = await load([...base, `pauseClockCorrection.enabled: ${raw}`].join('\n'));
      expect(cfg?.pauseClockCorrection).toEqual({ enabled: false });
    }
  });

  it('ignores a blank or non-positive threshold rather than making it zero', async () => {
    // `Number('') === 0`, and a zero threshold would read every scheduler hiccup
    // as a resume.
    for (const raw of ['', '0', '-1', '1.5', 'soon']) {
      const cfg = await load(
        [
          ...base,
          'pauseClockCorrection.enabled: true',
          `pauseClockCorrection.thresholdMs: ${raw}`,
        ].join('\n'),
      );
      expect(cfg?.pauseClockCorrection).toEqual({ enabled: true });
    }
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(
      storage,
      {
        provider: 'ollama',
        model: 'llama3.2',
        apiKey: 'sk',
        personality: 'p',
        pauseClockCorrection: { enabled: true, thresholdMs: 90_000 },
      },
      new InMemorySecretsResolver(),
    );
    const cfg = await readRawConfig(storage);
    expect(cfg?.pauseClockCorrection).toEqual({ enabled: true, thresholdMs: 90_000 });
  });
});
