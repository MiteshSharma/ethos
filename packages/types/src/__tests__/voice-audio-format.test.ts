import { describe, expect, it } from 'vitest';
import {
  isVoiceOutboundAdapter,
  type PlatformAdapter,
  type VoiceAudioFormat,
  voiceAudioExtension,
  voiceAudioFormatFromMime,
  voiceAudioMimeType,
} from '../platform';

const ALL_FORMATS: VoiceAudioFormat[] = [
  'opus',
  'ogg',
  'mp3',
  'wav',
  'pcm',
  'm4a',
  'aac',
  'amr',
  'silk',
  'webm',
  'flac',
];

function baseAdapter(): PlatformAdapter {
  return {
    id: 'mock',
    displayName: 'Mock',
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4000,
    start: async () => {},
    stop: async () => {},
    send: async () => ({ ok: true }),
    onMessage: () => {},
    health: async () => ({ ok: true }),
  };
}

describe('voiceAudioMimeType / voiceAudioExtension', () => {
  it('maps every format to a non-empty mime type and extension', () => {
    for (const format of ALL_FORMATS) {
      expect(voiceAudioMimeType(format), format).toMatch(/^audio\//);
      expect(voiceAudioExtension(format), format).toMatch(/^[a-z0-9]+$/);
    }
  });

  it('puts opus in an ogg container', () => {
    expect(voiceAudioMimeType('opus')).toBe('audio/ogg; codecs=opus');
    expect(voiceAudioExtension('opus')).toBe('ogg');
  });
});

describe('voiceAudioFormatFromMime', () => {
  it('round-trips every format from its canonical mime type', () => {
    for (const format of ALL_FORMATS) {
      expect(voiceAudioFormatFromMime(voiceAudioMimeType(format)), format).toBe(format);
    }
  });

  it('reads the codecs parameter before stripping it', () => {
    expect(voiceAudioFormatFromMime('audio/ogg; codecs=opus')).toBe('opus');
    expect(voiceAudioFormatFromMime('AUDIO/OGG;CODECS=OPUS')).toBe('opus');
    expect(voiceAudioFormatFromMime('audio/ogg')).toBe('ogg');
  });

  it('recognizes common aliases', () => {
    expect(voiceAudioFormatFromMime('audio/mp3')).toBe('mp3');
    expect(voiceAudioFormatFromMime('audio/x-wav')).toBe('wav');
    expect(voiceAudioFormatFromMime('audio/wave')).toBe('wav');
    expect(voiceAudioFormatFromMime('audio/x-m4a')).toBe('m4a');
    expect(voiceAudioFormatFromMime('audio/3gpp')).toBe('amr');
    expect(voiceAudioFormatFromMime('audio/x-flac')).toBe('flac');
    expect(voiceAudioFormatFromMime('audio/pcm')).toBe('pcm');
    expect(voiceAudioFormatFromMime('audio/opus')).toBe('opus');
  });

  it('returns undefined for unknown or absent mime types', () => {
    expect(voiceAudioFormatFromMime('application/octet-stream')).toBeUndefined();
    expect(voiceAudioFormatFromMime('video/mp4')).toBeUndefined();
    expect(voiceAudioFormatFromMime('')).toBeUndefined();
    expect(voiceAudioFormatFromMime(undefined)).toBeUndefined();
  });
});

describe('isVoiceOutboundAdapter', () => {
  it('is false for a plain adapter with no voice surface', () => {
    expect(isVoiceOutboundAdapter(baseAdapter())).toBe(false);
  });

  it('is false when caps are declared but the sink is missing', () => {
    const adapter = Object.assign(baseAdapter(), {
      voiceCaps: { inbound: ['ogg'], outbound: { formats: ['opus'], kind: 'voice_note' } },
    });
    expect(isVoiceOutboundAdapter(adapter as PlatformAdapter)).toBe(false);
  });

  it('is false when the sink exists but no outbound formats are declared', () => {
    const adapter = Object.assign(baseAdapter(), {
      voiceCaps: { inbound: ['ogg'], outbound: { formats: [], kind: 'voice_note' } },
      sendVoiceNote: async () => ({ ok: true }),
    });
    expect(isVoiceOutboundAdapter(adapter as PlatformAdapter)).toBe(false);
  });

  it('is false when voiceCaps is missing its outbound block', () => {
    const adapter = Object.assign(baseAdapter(), {
      voiceCaps: { inbound: ['ogg'] },
      sendVoiceNote: async () => ({ ok: true }),
    });
    expect(isVoiceOutboundAdapter(adapter as PlatformAdapter)).toBe(false);
  });

  it('is true for a well-formed voice adapter, and narrows the type', () => {
    const adapter: PlatformAdapter = Object.assign(baseAdapter(), {
      voiceCaps: {
        inbound: ['ogg' as const],
        outbound: {
          formats: ['opus' as const, 'mp3' as const],
          kind: 'voice_note' as const,
          flags: { ptt: true },
          maxBytes: 16 * 1024 * 1024,
        },
      },
      sendVoiceNote: async () => ({ ok: true }),
    });
    expect(isVoiceOutboundAdapter(adapter)).toBe(true);
    if (isVoiceOutboundAdapter(adapter)) {
      expect(adapter.voiceCaps.outbound.formats[0]).toBe('opus');
    }
  });
});
