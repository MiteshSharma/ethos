// Language-aware voice selection (voice V2 acceptance criterion).
//
// `resolveVoicePreferences()` has always preferred
// `personality.voice.languages[lang]` over the personality's default voice —
// and nothing ever told it what language the turn was in, so the rung was
// unreachable from a channel. A Spanish voice note got an English-voiced reply.
//
// The signal is the transcript, because `SttProvider.transcribeBuffer()`
// returns a bare string with no language tag. Detection is deliberately
// constrained to the languages the personality actually declares a voice for:
// a wrong guess picks the wrong voice, and "no confident answer" must land on
// the default rather than on a coin flip.

import type { AgentLoop } from '@ethosagent/core';
import { DefaultSttProviderRegistry } from '@ethosagent/core';
import type {
  AttachmentCache,
  PersonalityVoiceConfig,
  Storage,
  SttProvider,
} from '@ethosagent/types';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { Gateway } from '../index';
import { fakeAdapter, inbound, recordingTts, stubLoop } from './voice-fakes';

const attachmentCache: AttachmentCache = {
  write: async () => 'file:///cache/note.ogg',
  clear: async () => {},
  pruneOlderThan: async () => ({ removedCount: 0 }),
  resolveLocalPath: (url) => url.replace('file://', ''),
};

const storage = {
  readBytes: async () => Uint8Array.from([1, 2, 3]),
} as unknown as Storage;

function sttRegistry(transcript: string): DefaultSttProviderRegistry {
  const provider: SttProvider = {
    name: 'local-stt',
    caps: { kind: 'stt', formats: ['opus'], local: true, contractVersion: STT_CONTRACT_VERSION },
    transcribeBuffer: async () => transcript,
  };
  const registry = new DefaultSttProviderRegistry();
  registry.register('local-stt', () => provider);
  return registry;
}

/** Speak one voice note and report the voice the TTS provider was handed. */
async function voiceFor(opts: {
  transcript: string;
  personalityVoice: PersonalityVoiceConfig;
  globalTtsVoice?: string;
}): Promise<string | undefined> {
  const tts = recordingTts('wav');
  const adapter = fakeAdapter();
  const gw = new Gateway({
    bots: [
      {
        botKey: 'bot-a',
        loop: stubLoop() as AgentLoop,
        binding: { type: 'personality', name: 'polyglot' },
      },
    ],
    attachmentCache,
    storage,
    sttProviderRegistry: sttRegistry(opts.transcript),
    sttProviderName: 'local-stt',
    ttsProviderRegistry: tts.registry,
    ttsProviderName: 'local-tts',
    ...(opts.globalTtsVoice ? { ttsProviderConfig: { voice: opts.globalTtsVoice } } : {}),
    // `mirror_inbound` (the default) is enough: the inbound IS a voice note.
    personalityDirectory: {
      refresh: async () => {},
      has: () => true,
      list: () => [{ id: 'polyglot', name: 'Polyglot', isDefault: true }],
      voice: () => opts.personalityVoice,
    },
    clarifySweepIntervalMs: 0,
  });

  await gw.handleMessage(
    inbound({
      text: '',
      attachments: [
        { type: 'audio', ref: 'a1', url: 'file:///cache/note.ogg', mimeType: 'audio/ogg' },
      ],
    }),
    adapter.adapter,
  );
  expect(adapter.voiceSends).toHaveLength(1);
  return tts.calls[0]?.voice;
}

const POLYGLOT: PersonalityVoiceConfig = {
  tts_voice: 'default-voice',
  languages: { es: 'es-voice' },
};

describe('channel voice replies — language-aware voice selection', () => {
  it('a Spanish voice note is answered in the Spanish voice', async () => {
    const voice = await voiceFor({
      transcript: 'por favor reserva una mesa para dos en el restaurante que no está lejos',
      personalityVoice: POLYGLOT,
    });
    expect(voice).toBe('es-voice');
  });

  it("an English voice note falls back to the personality's default voice", async () => {
    // `en` is not a declared candidate, so detection returns nothing and the
    // default stands — the behaviour that existed before language detection did.
    const voice = await voiceFor({
      transcript: 'book me a table for two in the restaurant that is not far',
      personalityVoice: POLYGLOT,
    });
    expect(voice).toBe('default-voice');
  });

  it('a personality declaring no languages never triggers detection', async () => {
    const voice = await voiceFor({
      transcript: 'por favor reserva una mesa para dos en el restaurante',
      personalityVoice: { tts_voice: 'only-voice' },
    });
    expect(voice).toBe('only-voice');
  });

  it('an unintelligible transcript lands on the default, not a guess', async () => {
    const voice = await voiceFor({
      transcript: 'mmm',
      personalityVoice: POLYGLOT,
    });
    expect(voice).toBe('default-voice');
  });

  it('the language voice outranks the global config voice too', async () => {
    const voice = await voiceFor({
      transcript: 'por favor reserva una mesa para dos en el restaurante que no está lejos',
      personalityVoice: { languages: { es: 'es-voice' } },
      globalTtsVoice: 'am_michael',
    });
    expect(voice).toBe('es-voice');
  });
});
