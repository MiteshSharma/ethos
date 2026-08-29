import { describe, expect, it } from 'vitest';
import { DEFAULT_VOICE_MODE, shouldReplyWithVoice, type VoiceMode } from '../voice-mode';

// Full truth table: three modes × inbound audio × wake-triggered.
const TRUTH_TABLE: Array<[VoiceMode, boolean, boolean, boolean]> = [
  // mode, inboundHadAudio, wakeTriggered, expected
  ['off', false, false, false],
  ['off', false, true, false],
  ['off', true, false, false],
  ['off', true, true, false],
  ['mirror_inbound', false, false, false],
  ['mirror_inbound', false, true, true],
  ['mirror_inbound', true, false, true],
  ['mirror_inbound', true, true, true],
  ['all', false, false, true],
  ['all', false, true, true],
  ['all', true, false, true],
  ['all', true, true, true],
];

describe('shouldReplyWithVoice', () => {
  it.each(TRUTH_TABLE)(
    'mode=%s audio=%s wake=%s -> %s',
    (mode, inboundHadAudio, wakeTriggered, expected) => {
      expect(shouldReplyWithVoice({ mode, inboundHadAudio, wakeTriggered })).toBe(expected);
    },
  );

  it('treats an omitted wakeTriggered as not wake-triggered', () => {
    expect(shouldReplyWithVoice({ mode: 'mirror_inbound', inboundHadAudio: false })).toBe(false);
  });

  it('defaults a lane to mirroring the inbound modality', () => {
    expect(DEFAULT_VOICE_MODE).toBe('mirror_inbound');
  });
});
