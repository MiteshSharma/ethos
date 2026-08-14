import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { runSatelliteDoctor } from '../doctor';
import { createSherpaWakeEngineFactory } from '../engines/sherpa-wake-engine';
import { transcriptWakeEngineFactory } from '../engines/transcript-wake-engine';
import type { WakeEngineFactory } from '../wake-engine';

const MODEL_DIR = '/home/pi/.ethos/models/wake';

async function storageWithModels(): Promise<InMemoryStorage> {
  const storage = new InMemoryStorage();
  await storage.mkdir(MODEL_DIR);
  await storage.write(`${MODEL_DIR}/encoder.onnx`, 'x');
  await storage.write(`${MODEL_DIR}/decoder.onnx`, 'x');
  await storage.write(`${MODEL_DIR}/joiner.onnx`, 'x');
  await storage.write(`${MODEL_DIR}/tokens.txt`, 'x');
  return storage;
}

const throwingFactory: WakeEngineFactory = {
  name: 'exploding',
  probe: async () => {
    throw new Error('dlopen failed: wrong architecture (arm64 vs x86_64)');
  },
  create: () => {
    throw new Error('unreachable');
  },
};

describe('runSatelliteDoctor', () => {
  it('reports ok when every probe passes', async () => {
    const result = await runSatelliteDoctor({
      engineFactories: [transcriptWakeEngineFactory],
      storage: await storageWithModels(),
      modelDir: MODEL_DIR,
      audioDevice: { list: async () => [{ id: 'default', label: 'Built-in Mic' }] },
      gatewayProbe: async () => ({ ok: true, detail: 'HTTP 200' }),
    });

    expect(result.ok).toBe(true);
    expect(result.probes.map((p) => p.name)).toEqual([
      'engine:transcript',
      'models',
      'microphone',
      'gateway',
    ]);
  });

  it('turns a throwing engine probe into a row, not a crash', async () => {
    const result = await runSatelliteDoctor({
      engineFactories: [throwingFactory],
      storage: await storageWithModels(),
      modelDir: MODEL_DIR,
    });

    expect(result.ok).toBe(false);
    const row = result.probes.find((p) => p.name === 'engine:exploding');
    expect(row?.ok).toBe(false);
    expect(row?.detail).toMatch(/wrong architecture/);
  });

  it('names the missing model directory', async () => {
    const result = await runSatelliteDoctor({
      engineFactories: [transcriptWakeEngineFactory],
      storage: new InMemoryStorage(),
      modelDir: MODEL_DIR,
    });

    expect(result.ok).toBe(false);
    expect(result.probes.find((p) => p.name === 'models')?.detail).toBe(
      `model directory missing — ${MODEL_DIR}`,
    );
  });

  it('marks an unrun probe skipped rather than passed on a guess', async () => {
    const result = await runSatelliteDoctor({
      engineFactories: [transcriptWakeEngineFactory],
      storage: await storageWithModels(),
      modelDir: MODEL_DIR,
    });

    const mic = result.probes.find((p) => p.name === 'microphone');
    expect(mic?.skipped).toBe(true);
    expect(mic?.detail).toMatch(/^skipped —/);
    const gateway = result.probes.find((p) => p.name === 'gateway');
    expect(gateway?.skipped).toBe(true);
  });

  it('fails when the host enumerates no input device', async () => {
    const result = await runSatelliteDoctor({
      engineFactories: [transcriptWakeEngineFactory],
      storage: await storageWithModels(),
      modelDir: MODEL_DIR,
      audioDevice: { list: async () => [] },
    });

    expect(result.ok).toBe(false);
    expect(result.probes.find((p) => p.name === 'microphone')?.detail).toMatch(/no input devices/);
  });

  it('reports the sherpa engine unavailable because the native peer is absent', async () => {
    const factory = createSherpaWakeEngineFactory({
      storage: await storageWithModels(),
      modelDir: MODEL_DIR,
      files: {
        encoder: 'encoder.onnx',
        decoder: 'decoder.onnx',
        joiner: 'joiner.onnx',
        tokens: 'tokens.txt',
      },
    });

    const probe = await factory.probe();
    // `sherpa-onnx-node` is deliberately not installed in this repo. The probe
    // must say so in words an operator can act on — never report available.
    expect(probe.ok).toBe(false);
    expect(probe.engine).toBe('sherpa');
    expect(probe.detail).toMatch(/sherpa-onnx-node/);
    expect(probe.detail).toMatch(/not installed|failed to load/);
  });

  it('names the missing wake model file even before the native peer is checked', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(MODEL_DIR);
    const factory = createSherpaWakeEngineFactory({
      storage,
      modelDir: MODEL_DIR,
      files: {
        encoder: 'encoder.onnx',
        decoder: 'decoder.onnx',
        joiner: 'joiner.onnx',
        tokens: 'tokens.txt',
      },
    });
    const engine = factory.create();
    // `init()` reports the same distinct failures the probe does, so a host that
    // skipped the preflight still gets a diagnosable message rather than a
    // native-layer crash.
    await expect(engine.init([], { sensitivity: 0.5, confirmationFrames: 2 })).rejects.toThrow(
      /sherpa-onnx-node|encoder\.onnx/,
    );
  });

  it('skips the engine row entirely when a host configures no engines', async () => {
    const result = await runSatelliteDoctor({
      engineFactories: [],
      storage: await storageWithModels(),
      modelDir: MODEL_DIR,
    });
    expect(result.probes[0]).toMatchObject({ name: 'engine', skipped: true });
  });
});
