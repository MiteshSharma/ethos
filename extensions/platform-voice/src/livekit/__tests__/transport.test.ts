import { voiceLaneKey } from '@ethosagent/core';
import type { AgentEvent, PcmChunk } from '@ethosagent/types';
import type { AgentTurnRunner, VoiceSessionEvent } from '@ethosagent/voice-session';
import { VoiceSession } from '@ethosagent/voice-session';
import { describe, expect, it } from 'vitest';
import {
  deferred,
  FakeVad,
  makeClock,
  scriptedRunner,
  streamingStt,
  streamingTts,
  tick,
} from '../../__tests__/fakes';
import { VoiceChannelAdapter } from '../../adapter';
import type { LiveKitAudioFrame } from '../room-client';
import { createLiveKitTransport, LiveKitVoiceTransport, resamplePcm } from '../transport';
import {
  FakeLiveKitRoomClient,
  FakeTokenMinter,
  remoteSilenceFrame,
  remoteSpeechFrame,
  samplesToPcmBytes,
} from './livekit-fakes';

function makeSession(clock: { now: () => number }, runner: AgentTurnRunner): VoiceSession {
  return new VoiceSession({
    runner,
    stt: streamingStt('caller said hi'),
    tts: streamingTts(),
    vad: new FakeVad(),
    now: clock.now,
  });
}

function transportWith(
  client: FakeLiveKitRoomClient,
  callerId: string,
  extra: { outboundSampleRate?: number } = {},
): LiveKitVoiceTransport {
  return new LiveKitVoiceTransport({
    client,
    tokenMinter: new FakeTokenMinter(),
    config: {
      url: 'wss://lk.example.com',
      roomName: 'room-a',
      agentIdentity: 'agent',
      callerId,
      ...extra,
    },
  });
}

/** Emit `count` remote frames, advancing the injected clock so the session's
 *  endpoint detector commits deterministically (mirrors the core feedTransport). */
function feedRemote(
  client: FakeLiveKitRoomClient,
  clock: { advance: (ms: number) => void },
  frame: LiveKitAudioFrame,
  count: number,
  stepMs = 20,
): void {
  for (let i = 0; i < count; i++) {
    clock.advance(stepMs);
    client.emitRemote(frame);
  }
}

describe('resamplePcm', () => {
  it('decimates 48kHz -> 16kHz by an integer factor of 3 (length + rate honest)', () => {
    const input = new Int16Array(300);
    for (let i = 0; i < input.length; i++) input[i] = i;
    const out = resamplePcm(input, 48_000, 16_000);
    expect(out.length).toBe(100);
    expect(out[0]).toBe(input[0]);
    expect(out[1]).toBe(input[3]);
    expect(out[2]).toBe(input[6]);
  });

  it('returns the input unchanged when the rates match', () => {
    const input = new Int16Array([1, 2, 3]);
    expect(resamplePcm(input, 16_000, 16_000)).toBe(input);
  });

  it('handles a non-integer downsample ratio (44100 -> 16000)', () => {
    const out = resamplePcm(new Int16Array(441), 44_100, 16_000);
    expect(out.length).toBe(160);
  });

  it('throws on a non-positive sample rate', () => {
    expect(() => resamplePcm(new Int16Array(4), 0, 16_000)).toThrow();
    expect(() => resamplePcm(new Int16Array(4), 48_000, -1)).toThrow();
  });
});

describe('LiveKitVoiceTransport', () => {
  it('exposes the participant identity as callerId', () => {
    const transport = transportWith(new FakeLiveKitRoomClient(), 'room-participant-7');
    expect(transport.callerId).toBe('room-participant-7');
  });

  it('connect mints a token for the agent identity and subscribes to remote audio', async () => {
    const client = new FakeLiveKitRoomClient();
    const minter = new FakeTokenMinter();
    const transport = new LiveKitVoiceTransport({
      client,
      tokenMinter: minter,
      config: { url: 'wss://lk', roomName: 'r', agentIdentity: 'agent', callerId: 'c' },
    });

    await transport.connect();

    expect(minter.minted).toEqual([{ roomName: 'r', identity: 'agent' }]);
    expect(client.connectOpts).toEqual({
      url: 'wss://lk',
      token: 'fake-token:r:agent',
      identity: 'agent',
    });
    expect(client.remoteHandlerCount()).toBe(1);
  });

  it('converts inbound 48kHz frames to 16kHz PcmChunks for onAudio', async () => {
    const client = new FakeLiveKitRoomClient();
    const transport = transportWith(client, 'c');
    const chunks: PcmChunk[] = [];
    transport.onAudio((chunk) => chunks.push(chunk));
    await transport.connect();

    client.emitRemote(remoteSpeechFrame(960));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].sampleRate).toBe(16_000);
    expect(chunks[0].data.length).toBe(320);
  });

  it('publishes pcm reply frames as int16 samples at the outbound rate', () => {
    const client = new FakeLiveKitRoomClient();
    const transport = transportWith(client, 'c', { outboundSampleRate: 24_000 });

    transport.sendAudio({ audio: samplesToPcmBytes(new Int16Array([1, 2, 3, 4])), format: 'pcm' });

    expect(client.published).toHaveLength(1);
    expect(Array.from(client.published[0].samples)).toEqual([1, 2, 3, 4]);
    expect(client.published[0].sampleRate).toBe(24_000);
  });

  it('drops non-pcm outbound frames (no codec at the boundary)', () => {
    const client = new FakeLiveKitRoomClient();
    const transport = transportWith(client, 'c');

    transport.sendAudio({ audio: new Uint8Array([1, 2, 3]), format: 'opus' });

    expect(client.published).toHaveLength(0);
  });

  it('cleans up the audio bridge and disconnects on disconnect', async () => {
    const client = new FakeLiveKitRoomClient();
    const transport = transportWith(client, 'c');
    const chunks: PcmChunk[] = [];
    transport.onAudio((chunk) => chunks.push(chunk));
    await transport.connect();
    expect(client.remoteHandlerCount()).toBe(1);

    await transport.disconnect();

    expect(client.connected).toBe(false);
    expect(client.remoteHandlerCount()).toBe(0);
    // A stray frame after disconnect reaches nobody.
    client.emitRemote(remoteSpeechFrame());
    expect(chunks).toHaveLength(0);
  });
});

describe('LiveKitVoiceTransport <-> VoiceChannelAdapter <-> VoiceSession', () => {
  it('drives a full call: remote frames -> reply audio published on the local track', async () => {
    const clock = makeClock();
    const client = new FakeLiveKitRoomClient('+15551234567');
    const minter = new FakeTokenMinter();
    const transport = new LiveKitVoiceTransport({
      client,
      tokenMinter: minter,
      config: {
        url: 'wss://lk',
        roomName: 'room-a',
        agentIdentity: 'agent',
        callerId: '+15551234567',
      },
    });
    const session = new VoiceSession({
      runner: scriptedRunner([
        { type: 'text_delta', text: 'Hello there. ' },
        { type: 'text_delta', text: 'How can I help?' },
      ]),
      stt: streamingStt('hi'),
      tts: streamingTts(),
      vad: new FakeVad(),
      now: clock.now,
    });
    const events: VoiceSessionEvent[] = [];
    session.on((e) => events.push(e));
    const adapter = new VoiceChannelAdapter({ transport, session, bot: { match: '+1*' } });

    await adapter.start();
    expect(client.connected).toBe(true);
    expect(minter.minted).toEqual([{ roomName: 'room-a', identity: 'agent' }]);
    expect(adapter.laneKey).toBe(
      voiceLaneKey(adapter.botKey, { kind: 'livekit', id: '+15551234567' }),
    );

    feedRemote(client, clock, remoteSpeechFrame(), 5);
    feedRemote(client, clock, remoteSilenceFrame(), 30);
    await session.idle();

    expect(client.published.length).toBeGreaterThan(0);
    expect(adapter.lastReplyText()).toBe('Hello there. How can I help?');
    expect(events.some((e) => e.type === 'utterance_committed')).toBe(true);

    await adapter.stop();
    expect(client.connected).toBe(false);
    expect(client.remoteHandlerCount()).toBe(0);
  });

  it('propagates barge-in through the transport: interrupted reply + flush', async () => {
    const clock = makeClock();
    const client = new FakeLiveKitRoomClient('+1999');
    const gate = deferred();
    let secondYielded = false;
    const runner: AgentTurnRunner = {
      async *run(_text, opts): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', text: 'Hello there. ' };
        await gate.promise;
        if (opts?.abortSignal?.aborted) return;
        secondYielded = true;
        yield { type: 'text_delta', text: 'Second sentence.' };
      },
    };
    const session = new VoiceSession({
      runner,
      stt: streamingStt('hi'),
      tts: streamingTts(),
      vad: new FakeVad(),
      now: clock.now,
    });
    const events: VoiceSessionEvent[] = [];
    session.on((e) => events.push(e));
    const transport = new LiveKitVoiceTransport({
      client,
      tokenMinter: new FakeTokenMinter(),
      config: { url: 'wss://lk', roomName: 'r', agentIdentity: 'a', callerId: '+1999' },
    });
    const adapter = new VoiceChannelAdapter({ transport, session, bot: { match: '+1*' } });
    await adapter.start();

    feedRemote(client, clock, remoteSpeechFrame(), 5);
    feedRemote(client, clock, remoteSilenceFrame(), 30);
    for (let i = 0; i < 200 && client.published.length === 0; i++) await tick();
    await tick();
    expect(client.published.length).toBeGreaterThan(0);

    // Caller speaks over the reply -> barge-in, driven through the transport.
    clock.advance(20);
    client.emitRemote(remoteSpeechFrame());

    const interrupted = events.find((e) => e.type === 'interrupted');
    expect(interrupted).toMatchObject({ text: 'Hello there. [interrupted]' });
    expect(adapter.lastReplyText()).toBe('Hello there. [interrupted]');

    gate.resolve();
    await session.idle();
    expect(secondYielded).toBe(false);
    expect(events.some((e) => e.type === 'reply_complete')).toBe(false);
  });
});

describe('createLiveKitTransport (wiring seam)', () => {
  it('composes transport -> adapter -> session per participant', async () => {
    const clients: FakeLiveKitRoomClient[] = [];
    const makeAdapter = createLiveKitTransport({
      createClient: () => {
        const c = new FakeLiveKitRoomClient();
        clients.push(c);
        return c;
      },
      tokenMinter: new FakeTokenMinter(),
      room: { url: 'wss://lk', roomName: 'room-x', agentIdentity: 'agent' },
      bot: { id: 'reception', match: 'room-*' },
      createSession: () => makeSession(makeClock(), scriptedRunner([])),
    });

    const a1 = makeAdapter('caller-a');
    const a2 = makeAdapter('caller-b');

    expect(a1.callerId).toBe('caller-a');
    expect(a1.laneKey).toBe(voiceLaneKey('reception', { kind: 'livekit', id: 'caller-a' }));
    expect(a2.laneKey).toBe(voiceLaneKey('reception', { kind: 'livekit', id: 'caller-b' }));
    // One fresh client per participant — sessions do not share a room client.
    expect(clients).toHaveLength(2);

    await a1.start();
    expect(clients[0].connected).toBe(true);
    expect(clients[1].connected).toBe(false);
  });
});
