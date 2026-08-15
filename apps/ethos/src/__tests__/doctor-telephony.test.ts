import type { EthosConfig } from '@ethosagent/config';
import { describe, expect, it } from 'vitest';
import { computeDoctorExit, type DoctorFailFlags, telephonyReport } from '../commands/doctor';
import type { LiveKitMediaResolution } from '../livekit-media';

// The telephony rows answer what an operator needs BEFORE they dial. Every
// assertion below is on a question that used to have no answer in `ethos
// doctor`: is the listener even running, is the control plane constructible, did
// the media SDK load, who gets through, and which number reaches which agent.

type VoiceConfig = NonNullable<EthosConfig['voice']>;

function voice(overrides: Partial<VoiceConfig> = {}): VoiceConfig {
  return { bots: [], ...overrides } as VoiceConfig;
}

const MEDIA_MISSING: LiveKitMediaResolution = {
  ok: false,
  reason: '@livekit/rtc-node is not installed — install it with pnpm add @livekit/rtc-node',
};
const MEDIA_OK: LiveKitMediaResolution = {
  ok: true,
  createClient: () => {
    throw new Error('not called');
  },
  version: '0.13.12',
};

function render(cfg: VoiceConfig, media: LiveKitMediaResolution): Promise<string> {
  return telephonyReport(cfg, { resolveMedia: async () => media }).then((lines) =>
    lines.join('\n'),
  );
}

describe('doctor telephony rows', () => {
  it('reports each half as not configured on an unconfigured deployment', async () => {
    const out = await render(voice(), MEDIA_MISSING);
    expect(out).toContain('SIP trunk not configured');
    expect(out).toContain('LiveKit control plane not configured');
    expect(out).toContain('LiveKit media not needed');
    expect(out).toContain('No voice bots configured');
    // Nothing was probed, so nothing claims to have passed.
    expect(out).not.toContain('calls can carry audio');
  });

  it('reports the trunk, its provider, and whether the listener will run', async () => {
    const withSecret = await render(
      voice({
        trunk: { provider: 'twilio', trunkId: 'ST_1', webhookSecret: 'shh', fromNumber: '+15551' },
        livekit: { url: 'wss://lk.example', apiKey: 'k', apiSecret: 's' },
      }),
      MEDIA_OK,
    );
    expect(withSecret).toContain('twilio');
    expect(withSecret).toContain('ST_1');
    expect(withSecret).toContain('+15551');
    expect(withSecret).toContain('Inbound webhook secret set');
    expect(withSecret).toContain('/sip/inbound');

    const withoutSecret = await render(
      voice({ trunk: { provider: 'twilio', trunkId: 'ST_1' } }),
      MEDIA_OK,
    );
    // No secret → the listener stays off, which is the single most confusing
    // "my number rings and nothing happens" failure.
    expect(withoutSecret).toContain('webhookSecret is unset');
    expect(withoutSecret).toContain('listener stays off');
  });

  it('flags a trunk with no LiveKit control plane as a hard gap', async () => {
    const out = await render(voice({ trunk: { provider: 'livekit', trunkId: 'T1' } }), MEDIA_OK);
    expect(out).toContain('LiveKit control plane absent');
    expect(out).toContain('telephony is unavailable');
  });

  it('claims the control plane is CONSTRUCTIBLE, not verified', async () => {
    // Nothing here dials LiveKit. Saying "configured" where the operator would
    // read "reachable" is the failure mode this wording exists to avoid.
    const out = await render(
      voice({ livekit: { url: 'wss://lk.example', apiKey: 'k', apiSecret: 's' } }),
      MEDIA_OK,
    );
    expect(out).toContain('constructible');
    expect(out).toContain('not dialled from here');
  });

  it('reports the media resolution verbatim, including the reason when absent', async () => {
    const ok = await render(voice({ trunk: { provider: 'livekit', trunkId: 'T1' } }), MEDIA_OK);
    expect(ok).toContain('0.13.12');
    expect(ok).toContain('calls can carry audio');

    const absent = await render(
      voice({ trunk: { provider: 'livekit', trunkId: 'T1' } }),
      MEDIA_MISSING,
    );
    expect(absent).toContain(MEDIA_MISSING.ok ? '' : MEDIA_MISSING.reason);
    expect(absent).toContain('carry no audio');
  });

  it('reports the inbound gates, with defaults named as defaults', async () => {
    const defaults = await render(
      voice({ trunk: { provider: 'livekit', trunkId: 'T' } }),
      MEDIA_OK,
    );
    expect(defaults).toContain('concurrency 2 (default)');
    expect(defaults).toContain('per-caller/hour unlimited');
    expect(defaults).toContain('daily budget unlimited');
    expect(defaults).toContain('prewarm allowlisted (default)');
    expect(defaults).toContain('Allowlist 0 pattern(s)');
    expect(defaults).toContain('receptionist not configured');
    expect(defaults).toContain('owner not configured');

    const tuned = await render(
      voice({
        inbound: {
          concurrencyCap: 5,
          perCallerPerHour: 3,
          dailyBudgetUsd: 12.5,
          prewarm: 'all',
          allowlist: ['+1555*', '+4477*'],
          receptionist: 'front-desk',
          owner: { platform: 'telegram', chatId: '99' },
        },
      }),
      MEDIA_OK,
    );
    expect(tuned).toContain('concurrency 5');
    expect(tuned).toContain('per-caller/hour 3');
    expect(tuned).toContain('daily budget $12.5');
    expect(tuned).toContain('prewarm all');
    expect(tuned).toContain('Allowlist 2 pattern(s)');
    expect(tuned).toContain('receptionist front-desk');
    expect(tuned).toContain('telegram:99');
  });

  it('renders one number → bot → personality row per configured voice bot', async () => {
    const out = await render(
      voice({
        bots: [
          { id: 'reception', match: '+15551230000', bind: { type: 'personality', name: 'ada' } },
          { match: '+15559990000', bind: { type: 'team', name: 'support' } },
        ],
      }),
      MEDIA_OK,
    );
    expect(out).toContain('+15551230000 → reception → personality ada');
    // No explicit id → the botKey is a sha256 of `match`, said as such rather
    // than recomputed here (two derivations is how they drift).
    expect(out).toContain('+15559990000 → sha256(+15559990000) → team support');
  });

  it('never contributes to doctor’s exit code', async () => {
    // A deployment that does not do telephony is not unhealthy, and one that
    // does is not unhealthy for lacking an optional native package.
    const flags: DoctorFailFlags = {
      coreFailure: false,
      configuredMissing: false,
      awsFailed: false,
      requiredSecretMissing: false,
      dbUnopenable: false,
      gatewayStale: false,
      channelRejected: false,
      channelUnreachable: false,
    };
    expect(computeDoctorExit(flags)).toBe(0);
    // The flags struct is the only input to the verdict, and it has no
    // telephony member — the rows are informational by construction.
    expect(Object.keys(flags)).not.toContain('telephony');

    const configured = await render(
      voice({
        trunk: { provider: 'livekit', trunkId: 'T1', webhookSecret: 's' },
        livekit: { url: 'wss://lk.example', apiKey: 'k', apiSecret: 's' },
      }),
      MEDIA_MISSING,
    );
    const unconfigured = await render(voice(), MEDIA_MISSING);
    expect(configured.length).toBeGreaterThan(0);
    expect(unconfigured.length).toBeGreaterThan(0);
    expect(computeDoctorExit(flags)).toBe(0);
  });
});
