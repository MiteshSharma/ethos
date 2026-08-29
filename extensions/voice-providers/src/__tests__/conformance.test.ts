import type { SttProvider, TtsProvider, VoiceCapabilities } from '@ethosagent/types';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { validateSttProvider, validateTtsProvider, validateVoiceCaps } from '../conformance';
import { LocalSttProvider } from '../local-stt';
import { LocalTtsProvider } from '../local-tts';

describe('VoiceCapabilities conformance', () => {
  it('validates a correct STT caps object', () => {
    const caps: VoiceCapabilities = {
      kind: 'stt',
      formats: ['opus', 'mp3'],
      local: true,
      contractVersion: STT_CONTRACT_VERSION,
    };
    expect(validateVoiceCaps(caps)).toEqual([]);
  });

  it('validates a correct TTS caps object', () => {
    const caps: VoiceCapabilities = {
      kind: 'tts',
      formats: ['opus'],
      voices: ['alloy'],
      maxInputChars: 4096,
      contractVersion: 1,
    };
    expect(validateVoiceCaps(caps)).toEqual([]);
  });

  it('rejects empty formats', () => {
    const caps: VoiceCapabilities = {
      kind: 'stt',
      formats: [],
      contractVersion: STT_CONTRACT_VERSION,
    };
    expect(validateVoiceCaps(caps)).toContain('formats must be a non-empty array');
  });

  it('rejects invalid format values', () => {
    const caps: VoiceCapabilities = {
      kind: 'tts',
      formats: ['aac' as 'opus'],
      contractVersion: 1,
    };
    expect(validateVoiceCaps(caps).some((e) => e.includes('Invalid format'))).toBe(true);
  });

  it('rejects zero contractVersion', () => {
    const caps: VoiceCapabilities = {
      kind: 'stt',
      formats: ['opus'],
      contractVersion: 0,
    };
    expect(validateVoiceCaps(caps)).toContain('contractVersion must be >= 1');
  });

  it('rejects negative maxInputChars', () => {
    const caps: VoiceCapabilities = {
      kind: 'tts',
      formats: ['mp3'],
      maxInputChars: -1,
      contractVersion: 1,
    };
    expect(validateVoiceCaps(caps)).toContain('maxInputChars must be positive');
  });
});

describe('Provider contract conformance', () => {
  it('STT provider must have name and caps', () => {
    const provider: SttProvider = {
      name: 'test-stt',
      caps: { kind: 'stt', formats: ['opus'], contractVersion: STT_CONTRACT_VERSION },
      transcribeBuffer: async () => 'hello',
    };
    expect(provider.name).toBeTruthy();
    expect(provider.caps.kind).toBe('stt');
    expect(typeof provider.transcribeBuffer).toBe('function');
  });

  it('TTS provider must have name and caps', () => {
    const provider: TtsProvider = {
      name: 'test-tts',
      caps: { kind: 'tts', formats: ['opus'], contractVersion: 1 },
      synthesize: async () => ({ audio: new Uint8Array(0), format: 'opus' }),
    };
    expect(provider.name).toBeTruthy();
    expect(provider.caps.kind).toBe('tts');
    expect(typeof provider.synthesize).toBe('function');
  });

  it('TTS synthesize returns declared format', async () => {
    const provider: TtsProvider = {
      name: 'test-tts',
      caps: { kind: 'tts', formats: ['mp3'], contractVersion: 1 },
      synthesize: async () => ({ audio: new Uint8Array([1, 2, 3]), format: 'mp3' }),
    };
    const result = await provider.synthesize('hello');
    expect(provider.caps.formats).toContain(result.format);
  });

  it('detects TTS provider returning undeclared format', async () => {
    const provider: TtsProvider = {
      name: 'liar-tts',
      caps: { kind: 'tts', formats: ['mp3'], contractVersion: 1 },
      synthesize: async () => ({ audio: new Uint8Array([1, 2, 3]), format: 'opus' }),
    };
    const result = await provider.synthesize('hello');
    expect(provider.caps.formats).not.toContain(result.format);
  });

  it('detects STT provider with empty formats in caps', () => {
    const provider: SttProvider = {
      name: 'broken-stt',
      caps: { kind: 'stt', formats: [], contractVersion: STT_CONTRACT_VERSION },
      transcribeBuffer: async () => 'hello',
    };
    const errors = validateVoiceCaps(provider.caps);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors).toContain('formats must be a non-empty array');
  });

  it('local-stt caps pass conformance', () => {
    const provider = new LocalSttProvider();
    expect(provider.caps.local).toBe(true);
    expect(validateVoiceCaps(provider.caps)).toEqual([]);
  });

  it('local-tts caps pass conformance', () => {
    const provider = new LocalTtsProvider();
    expect(provider.caps.local).toBe(true);
    expect(validateVoiceCaps(provider.caps)).toEqual([]);
  });
});

// The STT contract moved from `transcribe(audioPath)` to
// `transcribeBuffer(audio)` with no deprecation window, so a v1 declaration is
// not "old but working" — it names a method that no longer exists. Conformance
// catches that before the first live utterance does.
describe('STT contract v2 migration', () => {
  it('rejects an STT provider still declaring contractVersion 1', () => {
    const errors = validateVoiceCaps({ kind: 'stt', formats: ['wav'], contractVersion: 1 });
    expect(errors.some((e) => e.includes('transcribeBuffer'))).toBe(true);
  });

  it('leaves TTS providers at contractVersion 1 alone — their contract did not move', () => {
    expect(validateVoiceCaps({ kind: 'tts', formats: ['wav'], contractVersion: 1 })).toEqual([]);
  });

  it('accepts a conforming buffer-based STT provider', () => {
    const provider: SttProvider = {
      name: 'good-stt',
      caps: { kind: 'stt', formats: ['wav'], contractVersion: STT_CONTRACT_VERSION },
      transcribeBuffer: async () => 'hello',
    };
    expect(validateSttProvider(provider)).toEqual([]);
  });

  it('rejects a provider that claims streaming without implementing it', () => {
    const provider: SttProvider = {
      name: 'liar-stt',
      caps: {
        kind: 'stt',
        formats: ['wav'],
        streaming: true,
        contractVersion: STT_CONTRACT_VERSION,
      },
      transcribeBuffer: async () => 'hello',
    };
    expect(validateSttProvider(provider)).toContain(
      'caps.streaming is true but transcribeStream(audio, opts?) is missing',
    );
  });

  it('rejects a TTS provider that claims streaming without implementing it', () => {
    const provider: TtsProvider = {
      name: 'liar-tts',
      caps: { kind: 'tts', formats: ['wav'], streaming: true, contractVersion: 1 },
      synthesize: async () => ({ audio: new Uint8Array(0), format: 'wav' }),
    };
    expect(validateTtsProvider(provider)).toContain(
      'caps.streaming is true but synthesizeStream(text, opts?) is missing',
    );
  });
});
