import { deriveBotKey, voiceLaneKey } from '@ethosagent/core';
import type { AgentEvent } from '@ethosagent/types';
import type { AgentTurnRunner, VoiceSessionEvent } from '@ethosagent/voice-session';
import { VoiceSession } from '@ethosagent/voice-session';
import { describe, expect, it } from 'vitest';
import { VoiceChannelAdapter } from '../adapter';
import {
  deferred,
  FakeVad,
  FakeVoiceTransport,
  feedTransport,
  makeClock,
  scriptedRunner,
  silenceFrame,
  speechFrame,
  streamingStt,
  streamingTts,
  tick,
} from './fakes';

function makeSession(clock: { now: () => number }, runner: AgentTurnRunner): VoiceSession {
  return new VoiceSession({
    runner,
    stt: streamingStt('caller said hi'),
    tts: streamingTts(),
    vad: new FakeVad(),
    now: clock.now,
  });
}

describe('VoiceChannelAdapter', () => {
  it('stamps botKey via deriveBotKey and builds the voice lane key', () => {
    const transport = new FakeVoiceTransport('+15551234567');
    const session = makeSession(makeClock(), scriptedRunner([]));
    const adapter = new VoiceChannelAdapter({ transport, session, bot: { match: '+1555*' } });

    expect(adapter.botKey).toBe(deriveBotKey('+1555*'));
    expect(adapter.callerId).toBe('+15551234567');
    expect(adapter.laneKey).toBe(
      voiceLaneKey(deriveBotKey('+1555*'), { kind: 'livekit', id: '+15551234567' }),
    );
  });

  it('honors an explicit bot id over the derived key', () => {
    const transport = new FakeVoiceTransport('room-participant-7');
    const session = makeSession(makeClock(), scriptedRunner([]));
    const adapter = new VoiceChannelAdapter({
      transport,
      session,
      bot: { id: 'reception', match: '+1*' },
    });

    expect(adapter.botKey).toBe('reception');
    expect(adapter.laneKey).toBe(
      voiceLaneKey('reception', { kind: 'livekit', id: 'room-participant-7' }),
    );
  });

  it('bridges a full call: inbound frames -> reply audio on the outbound sink', async () => {
    const clock = makeClock();
    const transport = new FakeVoiceTransport('+15551234567');
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
    expect(transport.connected).toBe(true);

    feedTransport(transport, clock, speechFrame(), 5);
    feedTransport(transport, clock, silenceFrame(), 30);
    await session.idle();

    // Two sentences -> two synthesized frames captured on the outbound sink.
    expect(transport.sentAudio).toHaveLength(2);
    expect(adapter.lastReplyText()).toBe('Hello there. How can I help?');
    expect(events.some((e) => e.type === 'utterance_committed')).toBe(true);

    await adapter.stop();
    expect(transport.connected).toBe(false);
  });

  it('barge-in through the transport interrupts the reply and persists [interrupted]', async () => {
    const clock = makeClock();
    const transport = new FakeVoiceTransport('+1999');
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
    const adapter = new VoiceChannelAdapter({ transport, session, bot: { match: '+1*' } });
    await adapter.start();

    feedTransport(transport, clock, speechFrame(), 5);
    feedTransport(transport, clock, silenceFrame(), 30);
    // First sentence's audio reaches the outbound sink before the caller cuts in.
    for (let i = 0; i < 200 && transport.sentAudio.length === 0; i++) await tick();
    await tick();
    expect(transport.sentAudio.length).toBeGreaterThan(0);

    // Caller speaks over the reply -> barge-in, driven through the transport.
    clock.advance(20);
    transport.emit(speechFrame());

    const interrupted = events.find((e) => e.type === 'interrupted');
    expect(interrupted).toMatchObject({ text: 'Hello there. [interrupted]' });
    expect(adapter.lastReplyText()).toBe('Hello there. [interrupted]');

    gate.resolve();
    await session.idle();
    expect(secondYielded).toBe(false);
    expect(events.some((e) => e.type === 'reply_complete')).toBe(false);
  });

  it('exempts audio from dedup but routes summary messages through it', async () => {
    const clock = makeClock();
    const transport = new FakeVoiceTransport('+1777');
    const session = new VoiceSession({
      runner: scriptedRunner([
        { type: 'text_delta', text: 'Reply one. ' },
        { type: 'text_delta', text: 'Reply two.' },
      ]),
      stt: streamingStt('hi'),
      tts: streamingTts(),
      vad: new FakeVad(),
      now: clock.now,
    });

    // Faithful stand-in for the gateway's single dedup gate
    // (extensions/gateway/src/dedup.ts — MessageDedupCache, keyed by
    // `${sessionId}:${content}`). The adapter never owns dedup; the gateway
    // gates adapter sends. Summaries flow through here — audio must NOT.
    const seen = new Set<string>();
    const delivered: string[] = [];
    const dedupedSink = (a: { sessionId: string; content: string }): void => {
      const key = `${a.sessionId}:${a.content}`;
      if (seen.has(key)) return; // duplicate suppressed
      seen.add(key);
      delivered.push(a.content);
    };

    const adapter = new VoiceChannelAdapter({
      transport,
      session,
      bot: { match: '+1*' },
      sendArtifact: dedupedSink,
    });
    await adapter.start();

    feedTransport(transport, clock, speechFrame(), 5);
    feedTransport(transport, clock, silenceFrame(), 30);
    await session.idle();

    // Audio bypassed the dedup gate entirely — it reached the transport sink.
    expect(transport.sentAudio.length).toBeGreaterThan(0);
    expect(delivered).toHaveLength(0);

    // A summary sent AS a message goes through the dedup gate; a duplicate drops.
    await adapter.sendArtifactMessage('Call summary: greeted the caller.');
    await adapter.sendArtifactMessage('Call summary: greeted the caller.');
    expect(delivered).toEqual(['Call summary: greeted the caller.']);
  });
});
