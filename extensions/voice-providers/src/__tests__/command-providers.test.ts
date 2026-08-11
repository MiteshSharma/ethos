import type { Logger, SecretsResolver, VoiceProviderFactoryContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { CommandSttProvider, commandSttFactory } from '../command-stt';
import { CommandTtsProvider, commandTtsFactory } from '../command-tts';

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
        command: 'whisper-cli -f {input_path} -otxt -of {output_path}',
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

  it('ignores an unknown output format rather than trusting it', () => {
    const provider = commandTtsFactory(ctx({ command: 'x {output_path}', outputFormat: 'flac' }));
    expect(provider.caps.formats).toEqual(['mp3']);
  });

  it('refuses to build without a command', () => {
    expect(() => commandTtsFactory(ctx({}))).toThrow(/requires a `command` template/);
  });
});
