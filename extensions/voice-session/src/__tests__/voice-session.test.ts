import type { AgentEvent, StreamingTtsProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { AgentTurnRunner, VoiceSessionEvent } from '../types';
import { VoiceSession } from '../voice-session';
import {
  batchStt,
  batchTts,
  deferred,
  FakeVad,
  feed,
  makeClock,
  scriptedRunner,
  silenceFrame,
  speechFrame,
  streamingStt,
  streamingTts,
  tick,
  waitForEvent,
} from './fakes';

function collect(session: VoiceSession): VoiceSessionEvent[] {
  const events: VoiceSessionEvent[] = [];
  session.on((e) => events.push(e));
  return events;
}

/** First byte of every `reply_audio` event, in emission order. */
function audioBytes(events: VoiceSessionEvent[]): number[] {
  return events
    .filter((e) => e.type === 'reply_audio')
    .map((e) => (e.type === 'reply_audio' ? (e.audio[0] ?? -1) : -1));
}

// Drives one full utterance: speech frames then enough trailing silence to
// commit via the endpoint detector (fake clock advances 20ms/frame).
function speakUtterance(session: VoiceSession, clock: { advance: (ms: number) => void }): void {
  feed(session, clock, speechFrame(), 5);
  feed(session, clock, silenceFrame(), 30);
}

describe('VoiceSession', () => {
  it('happy path: utterance -> sentences spoken in order -> reply_complete', async () => {
    const clock = makeClock();
    const runner = scriptedRunner([
      { type: 'text_delta', text: 'Hello there. ' },
      { type: 'text_delta', text: 'How are you today?' },
    ]);
    const session = new VoiceSession({
      runner,
      stt: streamingStt('hello world'),
      tts: streamingTts(),
      vad: new FakeVad(),
      now: clock.now,
    });
    const events = collect(session);

    speakUtterance(session, clock);
    await session.idle();

    const types = events.map((e) => e.type);
    expect(types).toContain('utterance_committed');
    expect(events.find((e) => e.type === 'utterance_committed')).toMatchObject({
      text: 'hello world',
    });

    const sentences = events
      .filter((e) => e.type === 'reply_sentence')
      .map((e) => (e.type === 'reply_sentence' ? e.text : ''));
    expect(sentences).toEqual(['Hello there.', 'How are you today?']);

    const audioCount = events.filter((e) => e.type === 'reply_audio').length;
    expect(audioCount).toBe(2);

    const complete = events.find((e) => e.type === 'reply_complete');
    expect(complete).toMatchObject({ text: 'Hello there. How are you today?' });
    expect(session.getState()).toBe('listening');
  });

  it('barge-in mid-speaking cancels playout, aborts the turn, and persists [interrupted]', async () => {
    const clock = makeClock();
    const gate = deferred();
    let secondYielded = false;
    const runner: AgentTurnRunner = {
      async *run(_text, opts): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', text: 'Hello there. ' };
        await gate.promise;
        if (opts?.abortSignal?.aborted) return;
        secondYielded = true;
        yield { type: 'text_delta', text: 'How are you?' };
      },
    };
    const session = new VoiceSession({
      runner,
      stt: streamingStt('hi'),
      tts: streamingTts(),
      vad: new FakeVad(),
      now: clock.now,
    });
    const events = collect(session);

    speakUtterance(session, clock);
    await waitForEvent(events, 'reply_audio'); // first sentence played
    await tick(); // let playout mark it played

    // User speaks over the reply -> barge-in.
    clock.advance(20);
    session.pushAudio(speechFrame());

    const interrupted = events.find((e) => e.type === 'interrupted');
    expect(interrupted).toMatchObject({ text: 'Hello there. [interrupted]' });
    expect(session.getState()).toBe('listening');

    gate.resolve(); // let the (now-aborted) runner unwind
    await session.idle();

    expect(secondYielded).toBe(false); // turn was aborted before the 2nd sentence
    expect(events.some((e) => e.type === 'reply_complete')).toBe(false);
    expect(session.lastReplyText()).toBe('Hello there. [interrupted]');
  });

  // Construction is TOTAL: a batch-only provider needs nothing injected. The
  // utterance-buffered fallback encodes the frames as a WAV in memory, so
  // there is no `pcmToPath` to forget and no session that throws without one.
  it('batch-only STT/TTS fallback path works', async () => {
    const clock = makeClock();
    const session = new VoiceSession({
      runner: scriptedRunner([{ type: 'text_delta', text: 'Done.' }]),
      stt: batchStt('batch transcript'),
      tts: batchTts(),
      vad: new FakeVad(),
      now: clock.now,
    });
    const events = collect(session);

    speakUtterance(session, clock);
    await session.idle();

    expect(events.find((e) => e.type === 'utterance_committed')).toMatchObject({
      text: 'batch transcript',
    });
    expect(events.filter((e) => e.type === 'reply_sentence').map((e) => e.type)).toHaveLength(1);
    expect(events.filter((e) => e.type === 'reply_audio')).toHaveLength(1);
    expect(events.find((e) => e.type === 'reply_complete')).toMatchObject({ text: 'Done.' });
  });

  // A streaming provider is used chunk-by-chunk (several `reply_audio` events
  // per sentence) AND the next sentence is synthesized while the current one is
  // still streaming — proven by the recorded call order, not by timing.
  it('streaming TTS: chunks play in order while the next sentence prefetches', async () => {
    const clock = makeClock();
    const calls: string[] = [];
    const gate = deferred();
    const tts: StreamingTtsProvider = {
      name: 'chunked-tts',
      caps: { kind: 'tts', formats: ['pcm'], streaming: true, contractVersion: 1 },
      synthesize: async () => ({ audio: new Uint8Array([0]), format: 'pcm' }),
      async *synthesizeStream(text) {
        for await (const sentence of text) {
          const first = sentence.startsWith('Hello');
          calls.push(`start:${sentence}`);
          yield { audio: new Uint8Array([first ? 1 : 3]), format: 'pcm' as const };
          if (first) await gate.promise;
          yield { audio: new Uint8Array([first ? 2 : 4]), format: 'pcm' as const };
          calls.push(`end:${sentence}`);
        }
      },
    };
    const session = new VoiceSession({
      runner: scriptedRunner([
        { type: 'text_delta', text: 'Hello there. ' },
        { type: 'text_delta', text: 'How are you today?' },
      ]),
      stt: streamingStt('hi'),
      tts,
      vad: new FakeVad(),
      now: clock.now,
    });
    const events = collect(session);

    speakUtterance(session, clock);
    await waitForEvent(events, 'reply_audio');
    await tick();

    // Sentence two synthesized to completion while sentence one is still held.
    expect(calls).toEqual([
      'start:Hello there.',
      'start:How are you today?',
      'end:How are you today?',
    ]);
    // …and not one byte of it has played out of turn.
    expect(audioBytes(events)).toEqual([1]);

    gate.resolve();
    await session.idle();

    expect(audioBytes(events)).toEqual([1, 2, 3, 4]);
    expect(events.find((e) => e.type === 'reply_complete')).toMatchObject({
      text: 'Hello there. How are you today?',
    });
  });

  it('never speaks thinking_delta or tool_* events', async () => {
    const clock = makeClock();
    const runner = scriptedRunner([
      { type: 'thinking_delta', thinking: 'let me think' },
      { type: 'tool_start', toolCallId: 't1', toolName: 'search', args: {} },
      { type: 'tool_progress', toolName: 'search', message: 'working', audience: 'internal' },
      { type: 'tool_end', toolCallId: 't1', toolName: 'search', ok: true, durationMs: 5 },
      { type: 'text_delta', text: 'Okay done. ' },
    ]);
    const session = new VoiceSession({
      runner,
      stt: streamingStt('question'),
      tts: streamingTts(),
      vad: new FakeVad(),
      now: clock.now,
    });
    const events = collect(session);

    speakUtterance(session, clock);
    await session.idle();

    const sentences = events
      .filter((e) => e.type === 'reply_sentence')
      .map((e) => (e.type === 'reply_sentence' ? e.text : ''));
    expect(sentences).toEqual(['Okay done.']);
    // Exactly one audio chunk — from the single spoken sentence, nothing else.
    expect(events.filter((e) => e.type === 'reply_audio')).toHaveLength(1);
  });
});
