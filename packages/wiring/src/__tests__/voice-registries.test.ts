import { describe, expect, it } from 'vitest';
import { createBuiltinVoiceRegistries } from '../voice-registries';

describe('createBuiltinVoiceRegistries', () => {
  // `command-stt` / `command-tts` were implemented but never registered, which
  // made the whisper.cpp / Piper / macOS `say` recipes unselectable from config.
  it('registers the command recipe providers alongside the network ones', () => {
    const { sttProviders, ttsProviders } = createBuiltinVoiceRegistries();
    expect(sttProviders.list()).toEqual(
      expect.arrayContaining(['openai-stt', 'groq-stt', 'local-stt', 'command-stt']),
    );
    expect(ttsProviders.list()).toEqual(
      expect.arrayContaining(['openai-tts', 'local-tts', 'command-tts']),
    );
  });

  it('builds command providers that advertise local capability (egress-gate exempt)', async () => {
    const { sttProviders, ttsProviders } = createBuiltinVoiceRegistries();
    const sttFactory = sttProviders.get('command-stt');
    const ttsFactory = ttsProviders.get('command-tts');
    expect(sttFactory).toBeDefined();
    expect(ttsFactory).toBeDefined();
    if (!sttFactory || !ttsFactory) return;

    const ctx = {
      config: { command: 'noop {input_path} {output_path}' },
      secrets: {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
        list: async () => [],
      },
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
        child() {
          return this;
        },
      },
    };
    expect((await sttFactory(ctx)).caps.local).toBe(true);
    expect((await ttsFactory(ctx)).caps.local).toBe(true);
  });

  it('returns fresh registries per call — plugin registrations do not leak between loops', () => {
    const a = createBuiltinVoiceRegistries();
    a.sttProviders.register('plugin-stt', () => {
      throw new Error('unreachable');
    });
    expect(createBuiltinVoiceRegistries().sttProviders.get('plugin-stt')).toBeUndefined();
  });
});
