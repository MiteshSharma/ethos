import { describe, expect, it } from 'vitest';
import {
  firstCallInvitation,
  type VoiceBotRow,
  voiceBotsPatchFromRows,
} from '../settings/lib/voice-bots';
import {
  type VoiceTelephonyFormValues,
  type VoiceTelephonyStoredSecrets,
  voiceBargeInFromConfig,
  voiceTelephonyPatch,
} from '../settings/lib/voice-telephony';

// Settings → Voice → Telephony, without mounting the form.
//
// Three of these keys come in blocks the CLI parser refuses to load half of, so
// "can this form save half a block" has to be answerable in a unit test. The
// other invariant asserted here is the one that silently destroys credentials
// if it regresses: a blank secret field KEEPS the stored secret, because the
// browser was never handed one to type back.

const NO_SECRETS: VoiceTelephonyStoredSecrets = {
  voiceTrunkPasswordPreview: null,
  voiceTrunkWebhookSecretPreview: null,
  voiceLivekitApiKeyPreview: null,
  voiceLivekitApiSecretPreview: null,
};

function values(over: Partial<VoiceTelephonyFormValues> = {}): VoiceTelephonyFormValues {
  return {
    voiceTrunkProvider: '',
    voiceTrunkId: '',
    voiceTrunkFromNumber: '',
    voiceTrunkUsername: '',
    voiceTrunkPassword: '',
    voiceTrunkWebhookSecret: '',
    voiceTrunkWebhookPath: '',
    voiceTrunkCodec: '',
    voiceLivekitUrl: '',
    voiceLivekitApiKey: '',
    voiceLivekitApiSecret: '',
    voiceInboundAllowlist: [],
    voiceInboundReceptionist: '',
    voiceInboundConcurrencyCap: null,
    voiceInboundPerCallerPerHour: null,
    voiceInboundDailyBudgetUsd: null,
    voiceInboundPrewarm: '',
    voiceInboundOwnerPlatform: '',
    voiceInboundOwnerChatId: '',
    voiceInboundOwnerBotKey: '',
    voiceBargeIn: {
      call: { energyThreshold: null, minSpeechMs: null, silenceMs: null },
      satellite: { energyThreshold: null, minSpeechMs: null, silenceMs: null },
    },
    ...over,
  };
}

function ok(result: ReturnType<typeof voiceTelephonyPatch>) {
  if (!result.ok) throw new Error(`expected a patch, got: ${result.error}`);
  return result.patch;
}

describe('voiceTelephonyPatch — the trunk block cannot be half-saved', () => {
  it('refuses a provider with no trunk id', () => {
    const result = voiceTelephonyPatch(values({ voiceTrunkProvider: 'twilio' }), NO_SECRETS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('trunk id');
  });

  it('clearing the provider clears the WHOLE block, not one key', () => {
    // Every other trunk field still holds text; none of it is sent, because a
    // trunk with no provider is not a trunk.
    const patch = ok(
      voiceTelephonyPatch(
        values({
          voiceTrunkProvider: '',
          voiceTrunkId: 'ST_left_over',
          voiceTrunkFromNumber: '+15551234567',
        }),
        NO_SECRETS,
      ),
    );
    expect(patch.voiceTrunkProvider).toBeNull();
    expect(patch).not.toHaveProperty('voiceTrunkId');
    expect(patch).not.toHaveProperty('voiceTrunkFromNumber');
  });

  it('saves a complete trunk, dropping only the keys left blank', () => {
    const patch = ok(
      voiceTelephonyPatch(
        values({
          voiceTrunkProvider: 'telnyx',
          voiceTrunkId: 'ST_abc',
          voiceTrunkFromNumber: '+15551234567',
          voiceTrunkCodec: 'g711',
        }),
        NO_SECRETS,
      ),
    );
    expect(patch.voiceTrunkProvider).toBe('telnyx');
    expect(patch.voiceTrunkId).toBe('ST_abc');
    expect(patch.voiceTrunkFromNumber).toBe('+15551234567');
    expect(patch.voiceTrunkCodec).toBe('g711');
    expect(patch.voiceTrunkUsername).toBeNull();
  });

  it('refuses a webhook path the RPC would reject', () => {
    const result = voiceTelephonyPatch(
      values({
        voiceTrunkProvider: 'generic',
        voiceTrunkId: 'ST_abc',
        voiceTrunkWebhookPath: 'voice/inbound',
      }),
      NO_SECRETS,
    );
    expect(result.ok).toBe(false);
  });
});

describe('voiceTelephonyPatch — a blank secret keeps the stored one', () => {
  const stored: VoiceTelephonyStoredSecrets = {
    voiceTrunkPasswordPreview: 'sk-…ab12',
    voiceTrunkWebhookSecretPreview: 'wh-…cd34',
    voiceLivekitApiKeyPreview: 'API…ef56',
    voiceLivekitApiSecretPreview: 'sec…gh78',
  };

  it('omits every untouched secret rather than sending null', () => {
    // Sending null would CLEAR the credential. Saving an unrelated field must
    // not delete the trunk password.
    const patch = ok(
      voiceTelephonyPatch(
        values({
          voiceTrunkProvider: 'twilio',
          voiceTrunkId: 'ST_abc',
          voiceLivekitUrl: 'wss://example.invalid',
        }),
        stored,
      ),
    );
    for (const key of [
      'voiceTrunkPassword',
      'voiceTrunkWebhookSecret',
      'voiceLivekitApiKey',
      'voiceLivekitApiSecret',
    ] as const) {
      expect(patch).not.toHaveProperty(key);
    }
  });

  it('sends a secret the user actually typed', () => {
    const patch = ok(
      voiceTelephonyPatch(
        values({
          voiceTrunkProvider: 'twilio',
          voiceTrunkId: 'ST_abc',
          voiceTrunkPassword: 'hunter2',
        }),
        stored,
      ),
    );
    expect(patch.voiceTrunkPassword).toBe('hunter2');
  });
});

describe('voiceTelephonyPatch — the LiveKit block cannot be half-saved', () => {
  it('refuses a URL with no key or secret anywhere', () => {
    const result = voiceTelephonyPatch(
      values({ voiceLivekitUrl: 'wss://example.invalid' }),
      NO_SECRETS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('API secret');
  });

  it('refuses a URL with a key but no secret', () => {
    const result = voiceTelephonyPatch(
      values({ voiceLivekitUrl: 'wss://example.invalid', voiceLivekitApiKey: 'API_k' }),
      NO_SECRETS,
    );
    expect(result.ok).toBe(false);
  });

  it('accepts a URL whose credentials are already stored', () => {
    const patch = ok(
      voiceTelephonyPatch(values({ voiceLivekitUrl: 'wss://example.invalid' }), {
        ...NO_SECRETS,
        voiceLivekitApiKeyPreview: 'API…ef56',
        voiceLivekitApiSecretPreview: 'sec…gh78',
      }),
    );
    expect(patch.voiceLivekitUrl).toBe('wss://example.invalid');
  });

  it('clearing the URL clears the whole block, secrets included', () => {
    const patch = ok(
      voiceTelephonyPatch(values({ voiceLivekitUrl: '', voiceLivekitApiKey: 'typed' }), NO_SECRETS),
    );
    expect(patch.voiceLivekitUrl).toBeNull();
    expect(patch).not.toHaveProperty('voiceLivekitApiKey');
  });
});

describe('voiceTelephonyPatch — the owner block cannot be half-saved', () => {
  it('refuses a platform with no chat id', () => {
    const result = voiceTelephonyPatch(
      values({ voiceInboundOwnerPlatform: 'telegram' }),
      NO_SECRETS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('chat id');
  });

  it('clearing the platform clears the whole notice route', () => {
    const patch = ok(voiceTelephonyPatch(values({ voiceInboundOwnerChatId: '123' }), NO_SECRETS));
    expect(patch.voiceInboundOwnerPlatform).toBeNull();
    expect(patch).not.toHaveProperty('voiceInboundOwnerChatId');
  });

  it('saves a complete destination', () => {
    const patch = ok(
      voiceTelephonyPatch(
        values({ voiceInboundOwnerPlatform: 'telegram', voiceInboundOwnerChatId: '123' }),
        NO_SECRETS,
      ),
    );
    expect(patch.voiceInboundOwnerPlatform).toBe('telegram');
    expect(patch.voiceInboundOwnerChatId).toBe('123');
    expect(patch.voiceInboundOwnerBotKey).toBeNull();
  });
});

describe('voiceTelephonyPatch — inbound hardening', () => {
  it('an empty allowlist CLEARS the key — that policy is a receptionist', () => {
    expect(ok(voiceTelephonyPatch(values(), NO_SECRETS)).voiceInboundAllowlist).toBeNull();
    // Whitespace-only entries are not a policy either.
    expect(
      ok(voiceTelephonyPatch(values({ voiceInboundAllowlist: ['  '] }), NO_SECRETS))
        .voiceInboundAllowlist,
    ).toBeNull();
  });

  it('keeps a real allowlist, trimmed', () => {
    expect(
      ok(
        voiceTelephonyPatch(
          values({ voiceInboundAllowlist: [' +15551234567 ', '+15559998888'] }),
          NO_SECRETS,
        ),
      ).voiceInboundAllowlist,
    ).toEqual(['+15551234567', '+15559998888']);
  });

  it('blank numeric guards clear back to their built-in defaults', () => {
    const patch = ok(voiceTelephonyPatch(values(), NO_SECRETS));
    expect(patch.voiceInboundConcurrencyCap).toBeNull();
    expect(patch.voiceInboundPerCallerPerHour).toBeNull();
    expect(patch.voiceInboundDailyBudgetUsd).toBeNull();
    expect(patch.voiceInboundPrewarm).toBeNull();
    expect(patch.voiceInboundReceptionist).toBeNull();
  });
});

describe('voiceTelephonyPatch — barge-in', () => {
  it('an untuned surface is omitted, not written empty', () => {
    expect(ok(voiceTelephonyPatch(values(), NO_SECRETS)).voiceBargeIn).toEqual({});
  });

  it('writes only the knobs a surface actually set', () => {
    const patch = ok(
      voiceTelephonyPatch(
        values({
          voiceBargeIn: {
            call: { energyThreshold: 0.2, minSpeechMs: null, silenceMs: 600 },
            satellite: { energyThreshold: null, minSpeechMs: null, silenceMs: null },
          },
        }),
        NO_SECRETS,
      ),
    );
    expect(patch.voiceBargeIn).toEqual({ call: { energyThreshold: 0.2, silenceMs: 600 } });
  });

  it('round-trips "never tuned" through the config hydrator', () => {
    const hydrated = voiceBargeInFromConfig({});
    const patch = ok(voiceTelephonyPatch(values({ voiceBargeIn: hydrated }), NO_SECRETS));
    expect(patch.voiceBargeIn).toEqual({});
  });

  it('hydrates a tuned surface and leaves the others blank', () => {
    expect(
      voiceBargeInFromConfig({ call: { energyThreshold: 0.3, minSpeechMs: null, silenceMs: 500 } }),
    ).toEqual({
      call: { energyThreshold: 0.3, minSpeechMs: null, silenceMs: 500 },
      satellite: { energyThreshold: null, minSpeechMs: null, silenceMs: null },
    });
  });

  // The form renders a row per surface in BARGE_IN_SURFACES, so a `browser`
  // block arriving from an older config must not grow a fourth row — and must
  // not be written back on the next save, which would resurrect a key the
  // config parser now refuses.
  it('ignores a browser block coming back from config', () => {
    const hydrated = voiceBargeInFromConfig({
      browser: { energyThreshold: 0.2, minSpeechMs: null, silenceMs: null },
    });
    expect(Object.keys(hydrated).sort()).toEqual(['call', 'satellite']);
    expect(
      ok(voiceTelephonyPatch(values({ voiceBargeIn: hydrated }), NO_SECRETS)).voiceBargeIn,
    ).toEqual({});
  });
});

describe('voiceBotsPatchFromRows', () => {
  function row(over: Partial<VoiceBotRow> = {}): VoiceBotRow {
    return {
      _id: 1,
      id: '',
      match: '+15551234567',
      bindType: 'personality',
      bindName: 'engineer',
      allowSlashSwitch: false,
      ...over,
    };
  }

  it('omits an empty id so the loader derives one', () => {
    const result = voiceBotsPatchFromRows([row()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bots[0]).toEqual({
      match: '+15551234567',
      bind: { type: 'personality', name: 'engineer' },
    });
  });

  it('carries an explicit id and the mid-call switch flag', () => {
    const result = voiceBotsPatchFromRows([row({ id: 'main-line', allowSlashSwitch: true })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bots[0]).toMatchObject({
      id: 'main-line',
      bind: { allowSlashSwitch: true },
    });
  });

  it('refuses a row with nothing to answer', () => {
    expect(voiceBotsPatchFromRows([row({ match: '  ' })]).ok).toBe(false);
  });

  it('refuses a number with nobody to answer it', () => {
    expect(voiceBotsPatchFromRows([row({ bindName: '' })]).ok).toBe(false);
  });

  it('refuses an id that would not survive as a config.yaml key', () => {
    expect(voiceBotsPatchFromRows([row({ id: 'main line' })]).ok).toBe(false);
  });

  it('refuses two rows claiming the same bot id', () => {
    const result = voiceBotsPatchFromRows([
      row({ _id: 1, id: 'main' }),
      row({ _id: 2, id: 'main', match: '+15559998888' }),
    ]);
    expect(result.ok).toBe(false);
  });
});

describe('firstCallInvitation (DR2)', () => {
  const base = {
    voiceTrunkProvider: 'twilio' as const,
    voiceTrunkId: 'ST_abc',
    voiceTrunkFromNumber: '+15551234567',
    voiceBots: [],
  };

  it('says nothing until a trunk is actually configured', () => {
    expect(firstCallInvitation({ ...base, voiceTrunkProvider: null })).toBeNull();
    expect(firstCallInvitation({ ...base, voiceTrunkId: null })).toBeNull();
  });

  it('prefers the number a bot answers, and names who picks up', () => {
    expect(
      firstCallInvitation({
        ...base,
        voiceBots: [
          {
            id: null,
            match: '+15559998888',
            bind: { type: 'personality', name: 'engineer', allowSlashSwitch: false },
          },
        ],
      }),
    ).toEqual({ number: '+15559998888', answeredBy: 'engineer' });
  });

  it('skips a wildcard row — a pattern is not a number you can dial', () => {
    expect(
      firstCallInvitation({
        ...base,
        voiceBots: [
          {
            id: null,
            match: '+1555*',
            bind: { type: 'personality', name: 'engineer', allowSlashSwitch: false },
          },
        ],
      }),
    ).toEqual({ number: '+15551234567', answeredBy: null });
  });

  it('says nothing when the trunk exposes no number to call', () => {
    expect(firstCallInvitation({ ...base, voiceTrunkFromNumber: null })).toBeNull();
  });
});
