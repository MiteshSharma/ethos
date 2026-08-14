import { describe, expect, it } from 'vitest';
import { deliveryAge, voiceChannelTtsOutFromConfig, voiceChannelTtsOutPatch } from '../Settings';

// Settings → Voice: the per-channel TTS-out round trip, without mounting the
// form — same seam as `voice-roster-rows.test.ts`.
//
// The key is tri-state in config.yaml (absent / true / false) and binary on
// screen, which is only honest because only `false` is load-bearing: the
// gateway silences a channel on `=== false`, and `true` behaves exactly like
// absent. So the switch shows "not silenced", and saving writes back only the
// silences.

describe('voiceChannelTtsOutFromConfig', () => {
  it('shows every known channel, on unless the operator silenced it', () => {
    expect(voiceChannelTtsOutFromConfig({ slack: false })).toEqual({
      telegram: true,
      slack: false,
      discord: true,
      whatsapp: true,
      email: true,
    });
  });

  it('treats an explicit true and an absent key the same — both are "may speak"', () => {
    expect(voiceChannelTtsOutFromConfig({ telegram: true })).toEqual(
      voiceChannelTtsOutFromConfig({}),
    );
  });

  it('ignores a platform no adapter can act on', () => {
    expect(voiceChannelTtsOutFromConfig({ carrier_pigeon: false })).not.toHaveProperty(
      'carrier_pigeon',
    );
  });
});

describe('voiceChannelTtsOutPatch', () => {
  it('writes only the silences, so a channel switched back on returns to inheriting', () => {
    expect(
      voiceChannelTtsOutPatch({
        telegram: true,
        slack: false,
        discord: true,
        whatsapp: true,
        email: true,
      }),
    ).toEqual({ slack: false });
  });

  it('clears the whole map when nothing is silenced', () => {
    expect(voiceChannelTtsOutPatch({ telegram: true, slack: true })).toEqual({});
  });

  it('round-trips a saved config unchanged', () => {
    const saved = { slack: false, email: false };
    expect(voiceChannelTtsOutPatch(voiceChannelTtsOutFromConfig(saved))).toEqual(saved);
  });
});

describe('deliveryAge', () => {
  const now = 10_000_000_000;
  it('answers "how stale", coarsely', () => {
    expect(deliveryAge(now - 5_000, now)).toBe('5s');
    expect(deliveryAge(now - 90_000, now)).toBe('1m');
    expect(deliveryAge(now - 3 * 3_600_000, now)).toBe('3h');
    expect(deliveryAge(now - 2 * 86_400_000, now)).toBe('2d');
  });

  it('never renders a negative age from a clock that ran backwards', () => {
    expect(deliveryAge(now + 5_000, now)).toBe('0s');
  });
});
