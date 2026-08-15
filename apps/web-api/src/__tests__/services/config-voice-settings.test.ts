import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
import { ConfigService } from '../../services/config.service';

// Settings → Voice parity (voice V1a A13): every config key the voice plans
// introduced is readable and writable through the same service the Settings
// page uses. The rule is "no yaml-only keys", so what these tests really assert
// is that a user never has to open config.yaml to change one of them.

const DATA = '/data';

const BASE = [
  'provider: anthropic',
  'model: claude-opus-4-7',
  'apiKey: sk-anthropic-1234567890abcdef',
  'personality: researcher',
];

describe('Settings → Voice config keys', () => {
  let storage: InMemoryStorage;
  let secrets: InMemorySecretsResolver;
  let service: ConfigService;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    secrets = new InMemorySecretsResolver();
    await storage.mkdir(DATA);
    const repo = new ConfigRepository({ dataDir: DATA, storage, secrets });
    service = new ConfigService({ config: repo, secrets });
  });

  async function seed(lines: string[]): Promise<void> {
    await storage.write(join(DATA, 'config.yaml'), [...BASE, ...lines].join('\n'));
  }

  async function yaml(): Promise<string> {
    return (await storage.read(join(DATA, 'config.yaml'))) ?? '';
  }

  it('reads the provider knobs that used to be yaml-only', async () => {
    await seed([
      'auxiliary.tts.outputFormat: wav',
      'auxiliary.tts.timeout: 45',
      'auxiliary.tts.maxTextLength: 2048',
      'auxiliary.asr.timeout: 20',
    ]);
    const config = await service.get();
    expect(config.voiceTtsOutputFormat).toBe('wav');
    expect(config.voiceTtsTimeoutMs).toBe(45);
    expect(config.voiceTtsMaxTextLength).toBe(2048);
    expect(config.voiceSttTimeoutMs).toBe(20);
  });

  it('writes the provider knobs, and null clears them again', async () => {
    await seed([]);
    await service.update({
      voiceTtsOutputFormat: 'opus',
      voiceTtsTimeoutMs: 30,
      voiceTtsMaxTextLength: 4096,
      voiceSttTimeoutMs: 15,
    });
    expect(await yaml()).toContain('auxiliary.tts.outputFormat: opus');
    expect((await service.get()).voiceTtsTimeoutMs).toBe(30);

    await service.update({
      voiceTtsOutputFormat: null,
      voiceTtsTimeoutMs: null,
      voiceTtsMaxTextLength: null,
      voiceSttTimeoutMs: null,
    });
    const cleared = await service.get();
    expect(cleared.voiceTtsOutputFormat).toBeNull();
    expect(cleared.voiceTtsTimeoutMs).toBeNull();
    expect(await yaml()).not.toContain('auxiliary.tts.timeout');
  });

  it('an unrecognized stored format reads as null instead of leaking through', async () => {
    await seed(['auxiliary.tts.outputFormat: flac']);
    expect((await service.get()).voiceTtsOutputFormat).toBeNull();
  });

  it('reads the egress allowlist, keeping "absent" distinct from "empty"', async () => {
    await seed([]);
    expect((await service.get()).voiceTrustedPlugins).toBeNull();

    await seed(['voice.trustedPlugins: openai-tts, elevenlabs']);
    expect((await service.get()).voiceTrustedPlugins).toEqual(['openai-tts', 'elevenlabs']);
  });

  it('writes the egress allowlist and clears it back off', async () => {
    await seed([]);
    await service.update({ voiceTrustedPlugins: ['openai-tts'] });
    expect(await yaml()).toContain('voice.trustedPlugins: openai-tts');

    await service.update({ voiceTrustedPlugins: null });
    expect((await service.get()).voiceTrustedPlugins).toBeNull();
    expect(await yaml()).not.toContain('voice.trustedPlugins');
  });

  it('reads and writes the channel voice-mode default', async () => {
    await seed(['voice.defaultMode: all']);
    expect((await service.get()).voiceDefaultMode).toBe('all');

    await service.update({ voiceDefaultMode: 'off' });
    expect((await service.get()).voiceDefaultMode).toBe('off');

    await service.update({ voiceDefaultMode: null });
    expect((await service.get()).voiceDefaultMode).toBeNull();
  });

  it('round-trips the command-provider shell templates', async () => {
    await seed([]);
    const ttsCommand =
      'say --file-format=WAVE --data-format=LEI16@22050 -o {output_path} -f {input_path}';
    const sttCommand =
      'whisper-cli -f {input_path} -otxt -of {input_path} && mv {input_path}.txt {output_path}';
    await service.update({
      voiceProvider: 'command-stt',
      voiceSttCommand: sttCommand,
      voiceTtsProvider: 'command-tts',
      voiceTtsCommand: ttsCommand,
      voiceTtsOutputFormat: 'wav',
    });

    const written = await yaml();
    expect(written).toContain('auxiliary.asr.provider: command-stt');
    expect(written).toContain('auxiliary.tts.provider: command-tts');

    const config = await service.get();
    expect(config.voiceProvider).toBe('command-stt');
    expect(config.voiceSttCommand).toBe(sttCommand);
    expect(config.voiceTtsProvider).toBe('command-tts');
    expect(config.voiceTtsCommand).toBe(ttsCommand);
    expect(config.voiceTtsOutputFormat).toBe('wav');
  });

  it('reads command templates written by hand, and null clears them', async () => {
    await seed([
      'auxiliary.asr.command: whisper-cli -f {input_path} -o {output_path}',
      'auxiliary.tts.command: piper -f {output_path} < {input_path}',
    ]);
    const before = await service.get();
    expect(before.voiceSttCommand).toBe('whisper-cli -f {input_path} -o {output_path}');
    expect(before.voiceTtsCommand).toBe('piper -f {output_path} < {input_path}');

    await service.update({ voiceSttCommand: null, voiceTtsCommand: null });
    const cleared = await service.get();
    expect(cleared.voiceSttCommand).toBeNull();
    expect(cleared.voiceTtsCommand).toBeNull();
    expect(await yaml()).not.toContain('auxiliary.tts.command');
  });

  it('leaves an untouched voice key alone when a sibling is updated', async () => {
    await seed(['voice.defaultMode: all', 'auxiliary.tts.timeout: 45']);
    await service.update({ voiceSttTimeoutMs: 9 });
    const config = await service.get();
    expect(config.voiceDefaultMode).toBe('all');
    expect(config.voiceTtsTimeoutMs).toBe(45);
    expect(config.voiceSttTimeoutMs).toBe(9);
  });
});
