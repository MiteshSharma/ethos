import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, readRawConfig, writeConfig } from '../index';

// `auxiliary.asr.*` / `auxiliary.tts.*` — the per-provider knobs.
//
// These keys were matched by the parser and then dropped on the floor: only
// provider/model/apiKey/voice/baseUrl/command were lifted onto `EthosConfig`,
// so a documented `auxiliary.tts.outputFormat: wav` silently did nothing. They
// are lifted now, and must survive a write/read round-trip too — a config the
// web Settings form rewrites must not lose them.

const BASE = ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: researcher'];

async function load(lines: string[]): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), [...BASE, ...lines].join('\n'));
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

describe('auxiliary voice provider knobs', () => {
  it('lifts outputFormat, timeout and maxTextLength onto the TTS block', async () => {
    const cfg = await load([
      'auxiliary.tts.provider: command-tts',
      'auxiliary.tts.command: say --file-format=WAVE -o {output_path} -f {input_path}',
      'auxiliary.tts.outputFormat: wav',
      'auxiliary.tts.timeout: 45',
      'auxiliary.tts.maxTextLength: 2000',
    ]);

    expect(cfg.auxiliary?.tts).toMatchObject({
      provider: 'command-tts',
      outputFormat: 'wav',
      timeout: 45,
      maxTextLength: 2000,
    });
  });

  it('lifts timeout onto the STT block', async () => {
    const cfg = await load([
      'auxiliary.asr.provider: command-stt',
      'auxiliary.asr.command: whisper-cli -f {input_path}',
      'auxiliary.asr.timeout: 300',
    ]);
    expect(cfg.auxiliary?.asr?.timeout).toBe(300);
  });

  it('drops a nonsense format or timeout instead of handing it to the provider', async () => {
    const cfg = await load([
      'auxiliary.tts.provider: command-tts',
      'auxiliary.tts.outputFormat: flac',
      'auxiliary.tts.timeout: soon',
      'auxiliary.tts.maxTextLength: -5',
    ]);
    expect(cfg.auxiliary?.tts?.outputFormat).toBeUndefined();
    expect(cfg.auxiliary?.tts?.timeout).toBeUndefined();
    expect(cfg.auxiliary?.tts?.maxTextLength).toBeUndefined();
  });

  it('survives a write/read round-trip', async () => {
    const cfg = await load([
      'auxiliary.asr.provider: command-stt',
      'auxiliary.asr.timeout: 300',
      'auxiliary.tts.provider: command-tts',
      'auxiliary.tts.outputFormat: wav',
      'auxiliary.tts.timeout: 45',
      'auxiliary.tts.maxTextLength: 2000',
    ]);

    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(storage, cfg);
    const reread = await readRawConfig(storage);

    expect(reread?.auxiliary?.asr?.timeout).toBe(300);
    expect(reread?.auxiliary?.tts).toMatchObject({
      outputFormat: 'wav',
      timeout: 45,
      maxTextLength: 2000,
    });
  });
});
