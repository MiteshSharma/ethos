// Voice-out now runs on DECLARED adapter caps (voice V2).
//
// The code this replaces asked `'sendVoice' in adapter`. That duck-type could
// not tell a playable voice bubble from a plain file attachment, could not name
// a container the platform accepts, and gave every adapter that had not been
// hand-wired a silent no-op. All three failure shapes are asserted here — and
// "silent" is the important word: every skip has to leave an event behind.

import type { AgentLoop } from '@ethosagent/core';
import type { AdapterVoiceCaps } from '@ethosagent/types';
import { voiceAudioMimeType } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { Gateway } from '../index';
import type { Transcoder } from '../transcode';
import {
  fakeAdapter,
  inbound,
  recordingObservability,
  recordingTts,
  stubLoop,
} from './voice-fakes';

const OPUS_CAPS: AdapterVoiceCaps = {
  inbound: ['opus'],
  outbound: { formats: ['opus', 'mp3'], kind: 'voice_note', maxBytes: 1_000 },
};

/** Converts by relabelling — the property under test is what the SINK saw. */
function fakeTranscoder(opts: { ok?: boolean } = {}): Transcoder {
  return {
    available: async () => true,
    transcode: async (req) => {
      const target = req.targets[0];
      if (opts.ok === false || target === undefined) {
        return { ok: false, code: 'unavailable', error: 'ffmpeg is not available' };
      }
      return {
        ok: true,
        data: Uint8Array.from([...req.data, 0xaa]),
        format: target,
        mimeType: voiceAudioMimeType(target),
        transcoded: true,
      };
    },
  };
}

function gatewayFor(opts: {
  loop?: AgentLoop;
  adapter: ReturnType<typeof fakeAdapter>;
  tts: ReturnType<typeof recordingTts>;
  observability: ReturnType<typeof recordingObservability>;
  transcoder?: Transcoder;
}) {
  return new Gateway({
    bots: [
      {
        botKey: 'bot-a',
        loop: opts.loop ?? stubLoop(),
        binding: { type: 'personality', name: 'default' },
      },
    ],
    ttsProviderRegistry: opts.tts.registry,
    ttsProviderName: 'local-tts',
    // Speak on every reply, so no inbound voice note is needed to reach the
    // synthesis path — the caps gate is what is under test, not the decision.
    defaultVoiceMode: 'all',
    observability: opts.observability,
    ...(opts.transcoder ? { transcoder: opts.transcoder } : {}),
    clarifySweepIntervalMs: 0,
  });
}

describe('Gateway voice-out — declared caps', () => {
  it('sends one voice note in the format the adapter declared, into its thread', async () => {
    const adapter = fakeAdapter({ voiceCaps: OPUS_CAPS });
    const tts = recordingTts('wav');
    const observability = recordingObservability();
    const gw = gatewayFor({ adapter, tts, observability, transcoder: fakeTranscoder() });

    await gw.handleMessage(inbound({ threadId: 'thread-7' }), adapter.adapter);

    expect(adapter.voiceSends).toHaveLength(1);
    const send = adapter.voiceSends[0];
    // `opus` is the adapter's FIRST declared format; the wav the provider emits
    // is transcoded into it rather than sent as-is.
    expect(send?.opts.format).toBe('opus');
    expect(send?.opts.mimeType).toBe('audio/ogg; codecs=opus');
    // Opus bytes ride in an Ogg container — the extension is `ogg`, not `opus`.
    expect(send?.opts.filename).toBe('reply.ogg');
    expect(send?.opts.threadId).toBe('thread-7');
    expect(Array.from(send?.audio ?? [])).toEqual([7, 8, 9, 10, 0xaa]);
  });

  it('skips an adapter that declares no caps — and says so', async () => {
    const adapter = fakeAdapter({ voiceCaps: null });
    const tts = recordingTts('wav');
    const observability = recordingObservability();
    const gw = gatewayFor({ adapter, tts, observability, transcoder: fakeTranscoder() });

    await gw.handleMessage(inbound(), adapter.adapter);

    expect(adapter.voiceSends).toHaveLength(0);
    // Not even synthesized: caps are checked before a cent is spent on TTS.
    expect(tts.calls).toHaveLength(0);
    expect(observability.find('gateway.voice_no_caps')?.details?.platform).toBe('telegram');
    // The written reply is untouched by any of this.
    expect(adapter.sent).toHaveLength(1);
  });

  it('sends exactly ONE voice note for a long multi-sentence reply', async () => {
    // Sentence-chunking is for live surfaces, where a listener is waiting on
    // the first sentence. On a channel it is eight notifications for one answer.
    const reply = Array.from({ length: 12 }, (_, i) => `This is sentence number ${i}.`).join(' ');
    const adapter = fakeAdapter({ voiceCaps: OPUS_CAPS });
    const tts = recordingTts('wav');
    const observability = recordingObservability();
    const gw = gatewayFor({
      loop: stubLoop(reply),
      adapter,
      tts,
      observability,
      transcoder: fakeTranscoder(),
    });

    await gw.handleMessage(inbound(), adapter.adapter);

    expect(adapter.voiceSends).toHaveLength(1);
    expect(tts.calls).toHaveLength(1);
    expect(tts.calls[0]?.text).toContain('sentence number 11');
  });

  it('refuses a format the adapter did not declare when there is no transcoder', async () => {
    // Sending mp3 bytes to a sink that declared opus produces an
    // undownloadable document, not a voice note. Skipping is the honest move.
    const adapter = fakeAdapter({ voiceCaps: OPUS_CAPS });
    const tts = recordingTts('wav');
    const observability = recordingObservability();
    const gw = gatewayFor({ adapter, tts, observability });

    await gw.handleMessage(inbound(), adapter.adapter);

    expect(adapter.voiceSends).toHaveLength(0);
    expect(observability.find('gateway.voice_format_unsupported')?.details?.format).toBe('wav');
  });

  it('sends without a transcoder when the synthesized format is already accepted', async () => {
    const adapter = fakeAdapter(); // declares wav
    const tts = recordingTts('wav');
    const observability = recordingObservability();
    const gw = gatewayFor({ adapter, tts, observability });

    await gw.handleMessage(inbound(), adapter.adapter);

    expect(adapter.voiceSends).toHaveLength(1);
    expect(adapter.voiceSends[0]?.opts.format).toBe('wav');
    expect(adapter.voiceSends[0]?.opts.filename).toBe('reply.wav');
  });

  it('skips a note that exceeds the platform byte cap', async () => {
    const adapter = fakeAdapter({
      voiceCaps: {
        inbound: ['wav'],
        outbound: { formats: ['wav'], kind: 'voice_note', maxBytes: 2 },
      },
    });
    const tts = recordingTts('wav');
    const observability = recordingObservability();
    const gw = gatewayFor({ adapter, tts, observability });

    await gw.handleMessage(inbound(), adapter.adapter);

    expect(adapter.voiceSends).toHaveLength(0);
    expect(observability.find('gateway.voice_too_large')?.details?.maxBytes).toBe(2);
  });
});

describe('Gateway voice-out — the hook-claimed reply path', () => {
  it('speaks a claimed reply through the same decision function', async () => {
    // A claimed reply is still a reply. If this path skipped the voice
    // decision, a lane in `all` mode would fall silent the moment a hook
    // answered for the agent — the "voice-in gets text-out" drift again,
    // arriving through a side door.
    const loop = stubLoop();
    loop.hooks.registerClaiming('gateway_message', async () => ({
      handled: true,
      reply: 'claimed answer',
    }));
    const adapter = fakeAdapter();
    const tts = recordingTts('wav');
    const observability = recordingObservability();
    const gw = gatewayFor({ loop, adapter, tts, observability });

    await gw.handleMessage(inbound({ text: '/ping', threadId: 'thread-2' }), adapter.adapter);

    expect(adapter.voiceSends).toHaveLength(1);
    expect(tts.calls[0]?.text).toBe('claimed answer');
    expect(adapter.voiceSends[0]?.opts.threadId).toBe('thread-2');
  });

  it('does not speak a claimed reply the platform never confirmed', async () => {
    const loop = stubLoop();
    loop.hooks.registerClaiming('gateway_message', async () => ({
      handled: true,
      reply: 'claimed answer',
    }));
    const adapter = fakeAdapter({ sendOk: false });
    const tts = recordingTts('wav');
    const observability = recordingObservability();
    const gw = gatewayFor({ loop, adapter, tts, observability });

    await gw.handleMessage(inbound({ text: '/ping' }), adapter.adapter);

    // Synthesizing audio for a message the user never received is pure waste.
    expect(adapter.voiceSends).toHaveLength(0);
    expect(tts.calls).toHaveLength(0);
  });
});

describe('Gateway voice-out — a transcode failure never breaks the turn', () => {
  it('records the failure, sends no audio, and still delivers the text reply', async () => {
    const adapter = fakeAdapter({ voiceCaps: OPUS_CAPS });
    const tts = recordingTts('wav');
    const observability = recordingObservability();
    const gw = gatewayFor({
      adapter,
      tts,
      observability,
      transcoder: fakeTranscoder({ ok: false }),
    });

    await gw.handleMessage(inbound(), adapter.adapter);

    expect(adapter.voiceSends).toHaveLength(0);
    const failure = observability.find('gateway.voice_transcode_failed');
    expect(failure?.details?.code).toBe('unavailable');
    // The written answer went out regardless — a missing voice note must not
    // cost the user the reply itself.
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.message.text).toBe('here you go');
  });
});
