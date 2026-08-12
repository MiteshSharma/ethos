import { readFile, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger, SecretsResolver, VoiceProviderFactoryContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { CommandSttProvider, commandSttFactory } from '../command-stt';
import { CommandTtsProvider, commandTtsFactory } from '../command-tts';
import { validateSttProvider } from '../conformance';

const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
};

const noopSecrets: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};

function ctx(config: Record<string, unknown>): VoiceProviderFactoryContext {
  return { config, secrets: noopSecrets, logger: noopLogger };
}

describe('CommandSttProvider', () => {
  it('has correct caps', () => {
    const provider = new CommandSttProvider({
      name: 'test-stt',
      command: 'echo "hello" > {output_path}',
    });
    expect(provider.name).toBe('test-stt');
    expect(provider.caps.kind).toBe('stt');
    expect(provider.caps.local).toBe(true);
    expect(provider.caps.formats).toContain('opus');
    expect(validateSttProvider(provider)).toEqual([]);
  });

  // The one provider that genuinely needs a path — it shells out to a binary.
  // So it writes its own temp file, gives it the right suffix, locks it to
  // 0o600, and deletes it. No caller materializes audio on its behalf.
  it('materializes the utterance itself, at 0o600, with a MIME-derived suffix', async () => {
    // The transcript is the input file's NAME; `cp -p` leaves a mode-preserving
    // copy behind so the test can inspect what the binary was actually handed.
    const provider = new CommandSttProvider({
      name: 'echo-stt',
      command: 'basename {input_path} > {output_path}; cp -p {input_path} {input_path}.seen',
    });

    const name = await provider.transcribeBuffer({
      data: new Uint8Array([1, 2, 3, 4]),
      mimeType: 'audio/webm',
    });

    // Suffix derived from the declared MIME, so the binary can sniff it.
    expect(name).toMatch(/^ethos-stt-[0-9a-f]{16}\.webm$/);

    const original = join(tmpdir(), name);
    const copy = `${original}.seen`;
    try {
      // The bytes the binary saw are the bytes we were handed.
      expect(Array.from(await readFile(copy))).toEqual([1, 2, 3, 4]);
      // Captured voice is written owner-only.
      expect((await stat(copy)).mode & 0o777).toBe(0o600);
      // ...and does not outlive the transcription that consumed it.
      await expect(stat(original)).rejects.toThrow();
    } finally {
      await unlink(copy).catch(() => {});
    }
  });

  it('defaults to a .wav suffix when the MIME is absent or unknown', async () => {
    const provider = new CommandSttProvider({
      name: 'name-stt',
      command: 'basename {input_path} > {output_path}',
    });
    await expect(provider.transcribeBuffer({ data: new Uint8Array([1]) })).resolves.toMatch(
      /\.wav$/,
    );
  });
});

describe('CommandTtsProvider', () => {
  it('has correct caps', () => {
    const provider = new CommandTtsProvider({
      name: 'test-tts',
      command: 'echo "audio" > {output_path}',
      outputFormat: 'mp3',
    });
    expect(provider.name).toBe('test-tts');
    expect(provider.caps.kind).toBe('tts');
    expect(provider.caps.local).toBe(true);
    expect(provider.caps.formats).toEqual(['mp3']);
  });
});

// The factories are what makes the whisper.cpp / Piper / macOS `say` recipes
// selectable from config — the classes existed, but nothing could construct
// them from `auxiliary.asr.provider: command-stt`.
describe('commandSttFactory', () => {
  it('builds a provider from the config command template', () => {
    const provider = commandSttFactory(
      ctx({
        name: 'whisper-cpp',
        command:
          'whisper-cli -f {input_path} -otxt -of {input_path} && mv {input_path}.txt {output_path}',
        languages: ['en', 'es'],
        timeout: 30,
      }),
    );
    expect(provider.name).toBe('whisper-cpp');
    expect(provider.caps.local).toBe(true);
    expect(provider.caps.languages).toEqual(['en', 'es']);
  });

  it('defaults the provider name when config omits it', () => {
    expect(commandSttFactory(ctx({ command: 'x {input_path} {output_path}' })).name).toBe(
      'command-stt',
    );
  });

  it('refuses to build without a command — a provider that can never run is worse than none', () => {
    expect(() => commandSttFactory(ctx({}))).toThrow(/requires a `command` template/);
    expect(() => commandSttFactory(ctx({ command: '   ' }))).toThrow(/requires a `command`/);
  });
});

describe('commandTtsFactory', () => {
  it('builds a provider from the config command template', () => {
    const provider = commandTtsFactory(
      ctx({
        name: 'piper',
        command: 'piper -m voice.onnx -f {output_path} < {input_path}',
        outputFormat: 'wav',
        maxTextLength: 2000,
        voices: ['en_US-amy'],
      }),
    );
    expect(provider.name).toBe('piper');
    expect(provider.caps.local).toBe(true);
    expect(provider.caps.formats).toEqual(['wav']);
    expect(provider.caps.maxInputChars).toBe(2000);
    expect(provider.caps.voices).toEqual(['en_US-amy']);
  });

  // `outputFormat` decides the extension `{output_path}` carries and the
  // `{format}` substitution — CLI synthesizers pick their container from one or
  // the other, so both have to be the configured format, not the `mp3` default.
  it('gives {output_path} the configured extension and substitutes {format}', async () => {
    const provider = commandTtsFactory(
      ctx({
        command: 'basename {output_path} .wav | tr -d "\\n" > {output_path}',
        outputFormat: 'wav',
      }),
    );
    const result = await provider.synthesize('hello');
    expect(new TextDecoder().decode(result.audio)).toMatch(/^ethos-tts-out-[0-9a-f]{16}$/);
    expect(result.format).toBe('wav');

    const formatEcho = commandTtsFactory(
      ctx({ command: 'printf %s {format} > {output_path}', outputFormat: 'wav' }),
    );
    expect(new TextDecoder().decode((await formatEcho.synthesize('hello')).audio)).toBe('wav');
  });

  it('ignores an unknown output format rather than trusting it', () => {
    const provider = commandTtsFactory(ctx({ command: 'x {output_path}', outputFormat: 'flac' }));
    expect(provider.caps.formats).toEqual(['mp3']);
  });

  it('refuses to build without a command', () => {
    expect(() => commandTtsFactory(ctx({}))).toThrow(/requires a `command` template/);
  });
});
