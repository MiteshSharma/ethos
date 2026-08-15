import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import { describe, expect, it, vi } from 'vitest';
import { resolveTelephonyMedia } from '../commands/gateway';

// `resolveTelephonyMedia` is the gateway's one call into the optional native
// media loader. It is a real function (not startup-script shape) precisely so
// the two decisions that matter can be driven directly: WHEN the dynamic import
// happens, and WHAT the operator is told at boot when it fails.

const GATEWAY = readFileSync(join(import.meta.dirname, '..', 'commands', 'gateway.ts'), 'utf-8');

type VoiceConfig = NonNullable<EthosConfig['voice']>;

function voice(overrides: Partial<VoiceConfig> = {}): VoiceConfig {
  return { bots: [], ...overrides } as VoiceConfig;
}

const TRUNK = { provider: 'livekit', trunkId: 'T1' } as const;
const LIVEKIT = { url: 'wss://lk.example', apiKey: 'k', apiSecret: 's' } as const;

/** Rejects like a real missing optional dependency. */
async function missingModule(): Promise<never> {
  const err = new Error("Cannot find package '@livekit/rtc-node'") as Error & { code: string };
  err.code = 'ERR_MODULE_NOT_FOUND';
  throw err;
}

describe('gateway telephony media binding', () => {
  it('attempts no import when no voice block is configured', async () => {
    const importModule = vi.fn(missingModule);
    const outcome = await resolveTelephonyMedia(undefined, { importModule });
    expect(importModule).not.toHaveBeenCalled();
    expect(outcome.livekit).toBeUndefined();
    expect(outcome.lines).toEqual([]);
  });

  it('attempts no import when voice is configured but telephony is not', async () => {
    // A deployment with voice bots but no trunk and no LiveKit has no media
    // path to resolve — a dynamic import of a native package is not free.
    const importModule = vi.fn(missingModule);
    const outcome = await resolveTelephonyMedia(voice(), { importModule });
    expect(importModule).not.toHaveBeenCalled();
    expect(outcome.lines).toEqual([]);
  });

  it('resolves once when a trunk is configured and reports the reason on failure', async () => {
    const importModule = vi.fn(missingModule);
    const outcome = await resolveTelephonyMedia(voice({ trunk: { ...TRUNK }, livekit: LIVEKIT }), {
      importModule,
    });
    expect(importModule).toHaveBeenCalledTimes(1);
    expect(outcome.livekit).toBeUndefined();

    const banner = outcome.lines.join('\n');
    expect(banner).toContain('voice media unavailable');
    expect(banner).toContain('is not installed');
    // An operator who rented a number deserves to learn at BOOT that the calls
    // they are about to receive cannot carry audio — not from a `failed` row.
    expect(banner).toContain('cannot carry audio');
    expect(banner).toContain('pnpm add @livekit/rtc-node');
  });

  it('resolves for a LiveKit-only deployment but omits the telephony sentence', async () => {
    // No trunk means no phone calls to warn about; the room transport is still
    // unavailable and still worth one line.
    const outcome = await resolveTelephonyMedia(voice({ livekit: LIVEKIT }), {
      importModule: missingModule,
    });
    const banner = outcome.lines.join('\n');
    expect(banner).toContain('voice media unavailable');
    expect(banner).not.toContain('cannot carry audio');
  });

  it('hands back a createClient binding when the module is usable', async () => {
    const outcome = await resolveTelephonyMedia(voice({ trunk: { ...TRUNK }, livekit: LIVEKIT }), {
      importModule: async () => ({
        Room: class {
          on = (): void => {};
          off = (): void => {};
        },
        RoomEvent: { TrackSubscribed: 'trackSubscribed', Disconnected: 'disconnected' },
        AudioStream: class {},
        AudioSource: class {},
        AudioFrame: class {},
        LocalAudioTrack: { createAudioTrack: () => ({}) },
        TrackPublishOptions: class {},
        TrackSource: { SOURCE_MICROPHONE: 1 },
        TrackKind: { KIND_AUDIO: 1 },
      }),
    });
    expect(outcome.livekit).toBeDefined();
    expect(typeof outcome.livekit?.createClient).toBe('function');
    expect(outcome.lines.join('\n')).toContain('calls can carry audio');
  });
});

describe('gateway telephony media wiring (source shape)', () => {
  // Booting the gateway needs adapters, SQLite files, a live LLM and a
  // foreground process that never returns, so the wiring rules inside
  // `runGatewayStart` are asserted against the source — the same idiom as
  // `gateway-telephony.test.ts`.

  it('resolves the media binding once, before any loop is built', () => {
    const resolveAt = GATEWAY.indexOf('const telephonyMedia = await resolveTelephonyMedia(');
    const loopAt = GATEWAY.indexOf('} = await createAgentLoop(config, {');
    expect(resolveAt).toBeGreaterThan(0);
    expect(loopAt).toBeGreaterThan(resolveAt);
    // Exactly one resolution site — a second would mean a second dynamic import
    // of a native package on every boot.
    expect(GATEWAY.split('await resolveTelephonyMedia(').length - 1).toBe(1);
  });

  it('forwards the binding into the system loop that owns the SIP voice stack', () => {
    expect(GATEWAY).toMatch(
      /\.\.\.\(telephonyMedia\.livekit \? \{ livekit: telephonyMedia\.livekit \} : \{\}\)/,
    );
  });

  it('prints the outcome in the startup banner', () => {
    expect(GATEWAY).toMatch(/for \(const line of telephonyMedia\.lines\) console\.log\(line\);/);
  });

  it('keeps the binding’s route to buildVoiceStack unbroken', () => {
    // The two remaining hops — `apps/ethos/src/wiring.ts` → the wiring package,
    // and `build-agent-loop.ts` → `buildVoiceStack`. Neither can be unit-tested
    // by building a loop (`buildAgentLoop` is a full composition needing Docker,
    // SQLite and a live LLM — see `safety-conformance-wiring.test.ts`), and a
    // dropped optional field is silent: it re-creates EXACTLY the bug this
    // change exists to fix, where `createSipAdapter` is undefined in every
    // shipped deployment and a call dies with "no SIP media binding".
    const appWiring = readFileSync(join(import.meta.dirname, '..', 'wiring.ts'), 'utf-8');
    expect(appWiring).toMatch(/\.\.\.\(opts\.livekit \? \{ livekit: opts\.livekit \} : \{\}\)/);

    const buildLoop = readFileSync(
      join(
        import.meta.dirname,
        '..',
        '..',
        '..',
        '..',
        'packages',
        'wiring',
        'src',
        'build-agent-loop.ts',
      ),
      'utf-8',
    );
    const call = buildLoop.slice(buildLoop.indexOf('await buildVoiceStack({'));
    expect(call.slice(0, 400)).toMatch(
      /\.\.\.\(opts\.livekit \? \{ livekit: opts\.livekit \} : \{\}\)/,
    );
  });
});
