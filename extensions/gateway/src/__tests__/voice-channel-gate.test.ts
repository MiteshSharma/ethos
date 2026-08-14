// `voice.channels.<platform>.ttsOut` — the operator's veto (voice V2).
//
// An operator turning a channel's voice off is a DEPLOYMENT decision; `/voice
// all` in a lane is a conversational one. When they disagree the operator wins,
// because the operator is the one who knows the shared Slack channel has forty
// people in it who did not ask to be spoken to.
//
// The veto is checked FIRST, before caps and before the provider, so a silenced
// channel never spends a token on synthesis it will not send.

import { describe, expect, it } from 'vitest';
import { Gateway } from '../index';
import {
  fakeAdapter,
  inbound,
  recordingObservability,
  recordingTts,
  stubLoop,
} from './voice-fakes';

function gatewayFor(opts: {
  adapter: ReturnType<typeof fakeAdapter>;
  tts: ReturnType<typeof recordingTts>;
  observability: ReturnType<typeof recordingObservability>;
  channelVoiceOut?: Record<string, boolean>;
}) {
  return new Gateway({
    bots: [
      { botKey: 'bot-a', loop: stubLoop(), binding: { type: 'personality', name: 'default' } },
    ],
    ttsProviderRegistry: opts.tts.registry,
    ttsProviderName: 'local-tts',
    defaultVoiceMode: 'all',
    observability: opts.observability,
    ...(opts.channelVoiceOut ? { channelVoiceOut: opts.channelVoiceOut } : {}),
    clarifySweepIntervalMs: 0,
  });
}

describe('per-channel TTS-out override', () => {
  it('an explicit false silences the platform even with the lane mode at `all`', async () => {
    const adapter = fakeAdapter({ platform: 'slack' });
    const tts = recordingTts('wav');
    const observability = recordingObservability();
    const gw = gatewayFor({ adapter, tts, observability, channelVoiceOut: { slack: false } });

    await gw.handleMessage(inbound({ platform: 'slack' }), adapter.adapter);

    expect(adapter.voiceSends).toHaveLength(0);
    // Checked before the provider: nothing was synthesized.
    expect(tts.calls).toHaveLength(0);
    expect(observability.find('gateway.voice_channel_disabled')?.details?.platform).toBe('slack');
    // The written reply is unaffected — this silences speech, not the answer.
    expect(adapter.sent).toHaveLength(1);
  });

  it('only the named platform is silenced', async () => {
    const adapter = fakeAdapter({ platform: 'telegram' });
    const tts = recordingTts('wav');
    const observability = recordingObservability();
    const gw = gatewayFor({ adapter, tts, observability, channelVoiceOut: { slack: false } });

    await gw.handleMessage(inbound({ platform: 'telegram' }), adapter.adapter);

    expect(adapter.voiceSends).toHaveLength(1);
    expect(observability.saw('gateway.voice_channel_disabled')).toBe(false);
  });

  it('an explicit true is not a veto — the lane mode still decides', async () => {
    const adapter = fakeAdapter({ platform: 'slack' });
    const tts = recordingTts('wav');
    const observability = recordingObservability();
    const gw = gatewayFor({ adapter, tts, observability, channelVoiceOut: { slack: true } });

    await gw.handleMessage(inbound({ platform: 'slack' }), adapter.adapter);

    expect(adapter.voiceSends).toHaveLength(1);
  });
});
