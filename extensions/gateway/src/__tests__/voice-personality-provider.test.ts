// A21 — the per-personality voice PROVIDER on the channel path.
//
// `voice.tts_voice` already followed the personality everywhere (A16). The
// PROVIDER did not: the gateway memoized one at boot, so whichever personality
// spoke first bound the whole process and `voice.tts_provider` was, in practice,
// a browser-talk-mode-only setting.
//
// Every assertion below is on which PROVIDER OBJECT ran — not on which function
// was called. And the adversarial case is the one that matters: the roster key
// is a label the operator typed, so a cloud entry named `local-*` must still be
// refused by the local-only egress gate, with ZERO synthesize calls. That shape
// is pinned at the core level in
// `packages/core/src/__tests__/voice-roster-resolution.test.ts`; this is the
// gateway mirror, because a gate enforced in the resolver and bypassed by the
// surface is not a gate.

import type { AgentLoop } from '@ethosagent/core';
import { DefaultHookRegistry, DefaultTtsProviderRegistry } from '@ethosagent/core';
import type {
  AdapterVoiceCaps,
  DeliveryResult,
  InboundMessage,
  PersonalityVoiceConfig,
  PlatformAdapter,
  TtsProvider,
  TtsProviderEntry,
  VoiceOutboundAdapter,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';

/** A TTS provider that records every synthesize call made through IT. */
function recordingTts(
  name: string,
  local: boolean,
): { provider: TtsProvider; spoke: Array<string | undefined> } {
  const spoke: Array<string | undefined> = [];
  return {
    spoke,
    provider: {
      name,
      caps: { kind: 'tts', formats: ['wav'], local, contractVersion: 1 },
      synthesize: async (_text, opts) => {
        spoke.push(opts?.voice);
        return { audio: new Uint8Array([1]), format: 'wav' as const };
      },
    },
  };
}

function stubLoop(): AgentLoop {
  return {
    hooks: new DefaultHookRegistry(),
    run: vi.fn(async function* () {
      yield { type: 'text_delta' as const, text: 'here you go' };
      yield { type: 'done' as const, text: 'here you go', turnCount: 1 };
    }),
  } as unknown as AgentLoop;
}

const WAV_CAPS: AdapterVoiceCaps = {
  inbound: ['wav'],
  outbound: { formats: ['wav'], kind: 'voice_note' },
};

function adapter(): PlatformAdapter & VoiceOutboundAdapter {
  return {
    id: 'telegram:bot-1',
    displayName: 'Telegram',
    capabilities: { platform: 'telegram' },
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    voiceCaps: WAV_CAPS,
    async sendVoiceNote(): Promise<DeliveryResult> {
      return { ok: true, messageId: 'v1' };
    },
    async start() {},
    async stop() {},
    async send(): Promise<DeliveryResult> {
      return { ok: true, messageId: 'm1' };
    },
    onMessage() {},
    async health() {
      return { ok: true };
    },
  };
}

let seq = 0;
function inbound(botKey: string): InboundMessage {
  seq++;
  return {
    platform: 'telegram',
    botKey,
    chatId: `C-${botKey}`,
    userId: 'U1',
    text: 'say something',
    isDm: true,
    isGroupMention: false,
    messageId: `msg-${seq}`,
    raw: null,
  };
}

/**
 * ONE gateway, TWO bots bound to two personalities — which is the shape the
 * bug lived in. A per-process memo cannot pass this; a per-roster-entry one can.
 */
function harness(opts: {
  roster?: Record<string, TtsProviderEntry>;
  voices: Record<string, PersonalityVoiceConfig | undefined>;
  trustedVoicePlugins?: ReadonlySet<string>;
  globalVoice?: string;
}) {
  const fallback = recordingTts('local-tts', true);
  const studio = recordingTts('cloud-tts', false);
  const registry = new DefaultTtsProviderRegistry();
  registry.register('local-tts', () => fallback.provider);
  registry.register('cloud-tts', () => studio.provider);

  const gateway = new Gateway({
    bots: Object.keys(opts.voices).map((personality) => ({
      botKey: `bot-${personality}`,
      loop: stubLoop(),
      binding: { type: 'personality' as const, name: personality },
    })),
    ttsProviderRegistry: registry,
    ttsProviderName: 'local-tts',
    ...(opts.globalVoice ? { ttsProviderConfig: { voice: opts.globalVoice } } : {}),
    ...(opts.roster ? { ttsProviderRoster: opts.roster } : {}),
    ...(opts.trustedVoicePlugins ? { trustedVoicePlugins: opts.trustedVoicePlugins } : {}),
    defaultVoiceMode: 'all',
    personalityDirectory: {
      refresh: async () => {},
      has: () => true,
      list: () => [],
      voice: (id) => opts.voices[id],
    },
    clarifySweepIntervalMs: 0,
  });

  const speakAs = (personality: string) =>
    gateway.handleMessage(inbound(`bot-${personality}`), adapter());

  return { gateway, fallback, studio, speakAs };
}

describe('gateway channel TTS — per-personality provider', () => {
  it('two personalities in ONE gateway speak through the providers they each named', async () => {
    const { fallback, studio, speakAs } = harness({
      roster: { studio: { provider: 'cloud-tts', voice: 'nova' } },
      voices: {
        // Names the roster entry — must reach the cloud provider.
        announcer: { tts_provider: 'studio' },
        // Names none — must stay on the `auxiliary.tts` default.
        housemate: { tts_voice: 'af_bella' },
      },
    });

    await speakAs('announcer');
    await speakAs('housemate');

    expect(studio.spoke).toEqual(['nova']);
    expect(fallback.spoke).toEqual(['af_bella']);
  });

  it('order does not matter — whoever speaks first does not bind the process', async () => {
    const { fallback, studio, speakAs } = harness({
      roster: { studio: { provider: 'cloud-tts', voice: 'nova' } },
      voices: { housemate: {}, announcer: { tts_provider: 'studio' } },
    });

    await speakAs('housemate');
    await speakAs('announcer');

    expect(fallback.spoke).toHaveLength(1);
    expect(studio.spoke).toEqual(['nova']);
  });

  it('an unknown roster name falls back to the default provider, never to silence', async () => {
    const { fallback, studio, speakAs } = harness({
      roster: { studio: { provider: 'cloud-tts' } },
      voices: { stranger: { tts_provider: 'nonexistent' } },
    });
    await speakAs('stranger');
    expect(fallback.spoke).toHaveLength(1);
    expect(studio.spoke).toHaveLength(0);
  });

  // The adversarial case, mirrored from the core suite.
  it('refuses a roster entry named local-* backed by a non-local provider — zero synthesize calls', async () => {
    const { gateway, fallback, studio, speakAs } = harness({
      roster: { 'local-studio': { provider: 'cloud-tts', voice: 'nova' } },
      voices: { sneaky: { tts_provider: 'local-studio' } },
      // Gate armed, allowlist empty: only `caps.local` providers may speak.
      trustedVoicePlugins: new Set<string>(),
    });

    await speakAs('sneaky');

    // Not one byte was synthesized — not by the disguised provider, and not by
    // a silent fall-through onto the local default either.
    expect(studio.spoke).toHaveLength(0);
    expect(fallback.spoke).toHaveLength(0);

    // ...and the refusal names the provider that was actually about to run,
    // never the label it was hiding behind.
    const status = await gateway.voiceProviderStatus();
    expect(status.ttsError).toContain('cloud-tts');
    expect(status.ttsError).not.toContain('local-studio');
  });

  it('allowlisting the LABEL does not help; allowlisting the provider id does', async () => {
    const byLabel = harness({
      roster: { 'local-studio': { provider: 'cloud-tts', voice: 'nova' } },
      voices: { sneaky: { tts_provider: 'local-studio' } },
      trustedVoicePlugins: new Set(['local-studio']),
    });
    await byLabel.speakAs('sneaky');
    expect(byLabel.studio.spoke).toHaveLength(0);

    const byId = harness({
      roster: { 'local-studio': { provider: 'cloud-tts', voice: 'nova' } },
      voices: { sneaky: { tts_provider: 'local-studio' } },
      trustedVoicePlugins: new Set(['cloud-tts']),
    });
    await byId.speakAs('sneaky');
    expect(byId.studio.spoke).toEqual(['nova']);
  });

  it('behaves exactly as before when no roster is configured', async () => {
    const { fallback, studio, speakAs } = harness({
      voices: { plain: undefined },
      globalVoice: 'am_michael',
    });
    await speakAs('plain');
    expect(fallback.spoke).toEqual(['am_michael']);
    expect(studio.spoke).toHaveLength(0);
  });

  it('voiceProviderStatus reports the DEFAULT entry, not whoever spoke last', async () => {
    const { gateway, speakAs } = harness({
      roster: { studio: { provider: 'cloud-tts' } },
      voices: { announcer: { tts_provider: 'studio' } },
    });
    await speakAs('announcer');
    const status = await gateway.voiceProviderStatus();
    expect(status.tts).toBe('local-tts');
    expect(status.ttsError).toBeUndefined();
  });
});
