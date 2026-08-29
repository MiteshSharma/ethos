import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, loadConfigStrict } from '../index';

// T15 — plan/phases/settings-navigation.md §8 "0a-1". `auxiliary.{asr,tts}.timeout`
// is seconds and always was, but the web UI shipped it labelled and bounded in
// milliseconds, so stored values like `30000` became an 8h20m budget on
// `command-stt` — a timeout that never fires. The shim reads anything above the
// roster field's own ceiling (3600) as milliseconds.
//
// Deleted in the same commit that removes the shim (`aux-timeout-shim-removal`
// in plan/uncompleted-tasks.md) — a test that outlives its shim is how shims
// become permanent.

const BASE = ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: researcher'];

async function load(
  lines: string[],
): Promise<NonNullable<Awaited<ReturnType<typeof loadConfigStrict>>>> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), [...BASE, ...lines].join('\n'));
  const loaded = await loadConfigStrict(storage);
  if (!loaded) throw new Error('loadConfigStrict returned null');
  return loaded;
}

describe('auxiliary timeout normalisation', () => {
  it('reads a millisecond value as seconds and says so once', async () => {
    const { config, deprecations, parseErrors } = await load([
      'auxiliary.asr.provider: command-stt',
      'auxiliary.asr.command: transcribe {input_path}',
      'auxiliary.asr.timeout: 30000',
    ]);
    expect(config.auxiliary?.asr?.timeout).toBe(30);
    // A repaired value is not a malformed config: the gateway exits on a parse
    // error, so the notice must not land there.
    expect(parseErrors).toEqual([]);
    const warnings = deprecations.filter((d) => d.includes('auxiliary.asr.timeout'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('30000');
    expect(warnings[0]).toContain('this field is seconds');
  });

  it('normalises the TTS default on the same rule', async () => {
    const { config, deprecations } = await load([
      'auxiliary.tts.provider: command-tts',
      'auxiliary.tts.timeout: 30000',
    ]);
    expect(config.auxiliary?.tts?.timeout).toBe(30);
    expect(deprecations.filter((d) => d.includes('auxiliary.tts.timeout'))).toHaveLength(1);
  });

  for (const [raw, expected, coerced] of [
    [120, 120, false],
    [3600, 3600, false],
    [3601, 4, true],
    [30_000, 30, true],
    [600_000, 600, true],
  ] as const) {
    it(`${raw} reads as ${expected}${coerced ? ' with a warning' : ' untouched'}`, async () => {
      const { config, deprecations } = await load([
        'auxiliary.asr.provider: command-stt',
        `auxiliary.asr.timeout: ${raw}`,
      ]);
      expect(config.auxiliary?.asr?.timeout).toBe(expected);
      expect(deprecations.filter((d) => d.includes('auxiliary.asr.timeout'))).toHaveLength(
        coerced ? 1 : 0,
      );
    });
  }

  it('leaves the ROSTER alone — it was always seconds on every surface', async () => {
    const { config, deprecations, parseErrors } = await load([
      'voice.stt.providers.fast.provider: command-stt',
      'voice.stt.providers.fast.timeout: 30000',
      'voice.tts.providers.loud.provider: command-tts',
      'voice.tts.providers.loud.timeout: 30000',
    ]);
    expect(config.voice?.stt?.providers?.fast?.timeout).toBe(30_000);
    expect(config.voice?.tts?.providers?.loud?.timeout).toBe(30_000);
    expect(deprecations).toEqual([]);
    expect(parseErrors).toEqual([]);
  });
});
