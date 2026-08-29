import { describe, expect, it } from 'vitest';
import { deriveChannelVoiceOut } from '../commands/gateway';

// `voice.channels.<platform>.ttsOut` is the operator's per-channel veto over
// spoken replies. The derivation has to keep three states apart: declared true,
// declared false, and NOT DECLARED — the last one inherits the lane's mode and
// must never reach the Gateway as a key.

describe('deriveChannelVoiceOut', () => {
  it('returns undefined when no channels block is configured', () => {
    expect(deriveChannelVoiceOut(undefined)).toBeUndefined();
  });

  it('returns undefined when the block declares no explicit ttsOut', () => {
    expect(deriveChannelVoiceOut({ slack: {}, telegram: {} })).toBeUndefined();
  });

  it('keeps both explicit booleans', () => {
    const derived = deriveChannelVoiceOut({ slack: { ttsOut: false }, telegram: { ttsOut: true } });
    expect(derived).toEqual({ slack: false, telegram: true });
  });

  it('drops platforms that inherit rather than declaring', () => {
    const derived = deriveChannelVoiceOut({ slack: { ttsOut: false }, discord: {} });
    expect(derived).toEqual({ slack: false });
    expect(derived && 'discord' in derived).toBe(false);
  });
});
