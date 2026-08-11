import type { StreamingSttProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { BufferedVoiceSpanWriter, type VoiceTurnSpan } from '../span-writer';
import { VoiceSession } from '../voice-session';
import {
  FakeVad,
  feed,
  makeClock,
  scriptedRunner,
  silenceFrame,
  speechFrame,
  streamingStt,
  streamingTts,
} from './fakes';

function writerCollecting(spans: VoiceTurnSpan[]): BufferedVoiceSpanWriter {
  return new BufferedVoiceSpanWriter({
    sink: {
      write(batch) {
        spans.push(...batch);
      },
    },
    // Timer off: the test flushes explicitly, so nothing depends on wall time.
    flushIntervalMs: 0,
  });
}

function failingStt(): StreamingSttProvider {
  return {
    name: 'boom-stt',
    caps: { kind: 'stt', formats: ['pcm'], streaming: true, contractVersion: 1 },
    transcribe: async () => '',
    // biome-ignore lint/correctness/useYield: the provider throws before it can yield
    async *transcribeStream() {
      throw new Error('stt down');
    },
  };
}

function speak(session: VoiceSession, clock: { advance: (ms: number) => void }): void {
  feed(session, clock, speechFrame(), 5);
  feed(session, clock, silenceFrame(), 30);
}

describe('VoiceSession latency spans', () => {
  it('stamps the provider that actually ran into every span of the turn', async () => {
    const clock = makeClock();
    const spans: VoiceTurnSpan[] = [];
    const writer = writerCollecting(spans);
    const session = new VoiceSession({
      runner: scriptedRunner([{ type: 'text_delta', text: 'Hi there.' }]),
      stt: streamingStt('hello'),
      tts: streamingTts(),
      vad: new FakeVad(),
      now: clock.now,
      spans: writer,
      laneKey: 'voice:bot:caller',
    });

    speak(session, clock);
    await session.idle();
    await writer.close();

    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) {
      expect(s.sttProvider).toBe('fake-stt');
      expect(s.ttsProvider).toBe('fake-tts');
      expect(s.laneKey).toBe('voice:bot:caller');
      expect(s.turnId).toBe('u1');
    }
  });

  it('emits stt, llm_first_sentence, tts_first_audio and turn stages', async () => {
    const clock = makeClock();
    const spans: VoiceTurnSpan[] = [];
    const writer = writerCollecting(spans);
    const session = new VoiceSession({
      runner: scriptedRunner([{ type: 'text_delta', text: 'One. Two.' }]),
      stt: streamingStt('hello'),
      tts: streamingTts(),
      vad: new FakeVad(),
      now: clock.now,
      spans: writer,
    });

    speak(session, clock);
    await session.idle();
    await writer.close();

    const stages = spans.map((s) => s.stage);
    expect(stages).toContain('stt');
    expect(stages).toContain('llm_first_sentence');
    expect(stages).toContain('tts_first_audio');
    expect(stages).toContain('turn');
    // One first-sentence marker per turn, not one per sentence.
    expect(stages.filter((s) => s === 'llm_first_sentence')).toHaveLength(1);
    expect(stages.filter((s) => s === 'tts_first_audio')).toHaveLength(1);
  });

  it('gives consecutive utterances distinct turn ids', async () => {
    const clock = makeClock();
    const spans: VoiceTurnSpan[] = [];
    const writer = writerCollecting(spans);
    const session = new VoiceSession({
      runner: scriptedRunner([{ type: 'text_delta', text: 'Yes.' }]),
      stt: streamingStt('hello'),
      tts: streamingTts(),
      vad: new FakeVad(),
      now: clock.now,
      spans: writer,
    });

    speak(session, clock);
    await session.idle();
    speak(session, clock);
    await session.idle();
    await writer.close();

    expect(new Set(spans.map((s) => s.turnId))).toEqual(new Set(['u1', 'u2']));
  });

  it('records an error-status stt span when transcription throws', async () => {
    const clock = makeClock();
    const spans: VoiceTurnSpan[] = [];
    const writer = writerCollecting(spans);
    const session = new VoiceSession({
      runner: scriptedRunner([]),
      stt: failingStt(),
      tts: streamingTts(),
      vad: new FakeVad(),
      now: clock.now,
      spans: writer,
    });

    speak(session, clock);
    await session.idle();
    await writer.close();

    const stt = spans.find((s) => s.stage === 'stt');
    expect(stt).toMatchObject({ status: 'error', sttProvider: 'boom-stt' });
    expect(stt?.error).toContain('stt down');
    expect(spans.find((s) => s.stage === 'turn')).toMatchObject({ status: 'error' });
  });

  it('runs uninstrumented when no span writer is injected', async () => {
    const clock = makeClock();
    const session = new VoiceSession({
      runner: scriptedRunner([{ type: 'text_delta', text: 'Fine.' }]),
      stt: streamingStt('hello'),
      tts: streamingTts(),
      vad: new FakeVad(),
      now: clock.now,
    });

    speak(session, clock);
    await expect(session.idle()).resolves.toBeUndefined();
  });
});
