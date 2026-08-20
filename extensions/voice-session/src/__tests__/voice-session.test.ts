import type { AgentEvent, StreamingTtsProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { AgentTurnRunner, VoiceSessionEvent } from '../types';
import { VoiceSession } from '../voice-session';
import {
  batchStt,
  batchTts,
  deferred,
  FakeTimerClock,
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
  waitForTimer,
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

  // Bug: bargeIn() was gated on `speech` alone, so it re-fired on every
  // subsequent frame of the user's continued talking (no intervening
  // silence->speech edge) — not just the first frame that interrupted the
  // reply. Once state flipped to 'listening', every further speech-positive
  // frame from the SAME breath re-triggered a full barge-in cycle against
  // whatever turn came next, cancelling it before it could say a word.
  it('barge-in fires once per speech onset, not once per continuing speech frame', async () => {
    const clock = makeClock();
    const gate = deferred();
    const runner: AgentTurnRunner = {
      async *run(_text, opts): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', text: 'Hello there. ' };
        await gate.promise;
        if (opts?.abortSignal?.aborted) return;
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
    await tick();

    // User starts talking over the reply -> exactly one barge-in.
    clock.advance(20);
    session.pushAudio(speechFrame());

    // Same continuous speech, several more frames, no intervening silence.
    for (let i = 0; i < 10; i++) {
      clock.advance(20);
      session.pushAudio(speechFrame());
    }

    const interruptions = events.filter((e) => e.type === 'interrupted');
    expect(interruptions).toHaveLength(1);
    expect(interruptions[0]).toMatchObject({ text: 'Hello there. [interrupted]' });
    expect(session.getState()).toBe('listening');

    gate.resolve();
    await session.idle();
  });

  // Once the session is already 'listening' (no reply in flight, nothing to
  // interrupt), continued speech must not invoke bargeIn() at all — it's
  // ordinary mic audio accumulating toward the next endpoint commit.
  it('continued speech while already listening does not trigger barge-in', async () => {
    const clock = makeClock();
    const session = new VoiceSession({
      runner: scriptedRunner([{ type: 'text_delta', text: 'Done.' }]),
      stt: streamingStt('hi'),
      tts: streamingTts(),
      vad: new FakeVad(),
      now: clock.now,
    });
    const events = collect(session);

    speakUtterance(session, clock);
    await session.idle();
    expect(session.getState()).toBe('listening');

    for (let i = 0; i < 5; i++) {
      clock.advance(20);
      session.pushAudio(speechFrame());
    }

    expect(events.some((e) => e.type === 'interrupted')).toBe(false);
  });

  // A genuinely new speech onset — silence, THEN speech again — while the
  // agent is speaking a LATER reply must still trigger its own barge-in. The
  // rising-edge gate must re-arm once speech drops back to false, not stay
  // latched off for the rest of the session.
  it('a fresh speech onset after silence triggers a new barge-in on a later turn', async () => {
    const clock = makeClock();
    const gate1 = deferred();
    const gate2 = deferred();
    let call = 0;
    const runner: AgentTurnRunner = {
      async *run(_text, opts): AsyncGenerator<AgentEvent> {
        call += 1;
        const gate = call === 1 ? gate1 : gate2;
        yield { type: 'text_delta', text: call === 1 ? 'First reply. ' : 'Second reply. ' };
        await gate.promise;
        if (opts?.abortSignal?.aborted) return;
        yield { type: 'text_delta', text: 'more.' };
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
    const audioCount = (): number => events.filter((e) => e.type === 'reply_audio').length;

    speakUtterance(session, clock);
    await waitForEvent(events, 'reply_audio'); // first reply's sentence played
    await tick();

    // First onset -> barge-in #1, interrupting the first reply.
    clock.advance(20);
    session.pushAudio(speechFrame());
    expect(events.filter((e) => e.type === 'interrupted')).toHaveLength(1);
    gate1.resolve(); // let the (now-aborted) first turn unwind
    await tick();

    // Finish the second utterance: normal STT capture while 'listening', not
    // barge-in — speech continues from the barge-in frame, then enough
    // trailing silence for the endpoint detector to commit.
    feed(session, clock, speechFrame(), 5);
    feed(session, clock, silenceFrame(), 30);

    // Wait for the second reply's audio.
    const audioBefore = audioCount();
    const start = Date.now();
    while (audioCount() <= audioBefore) {
      if (Date.now() - start > 2000) throw new Error('timeout waiting for second reply audio');
      await tick();
    }
    await tick();

    // Second, genuinely fresh onset (silence intervened) -> barge-in #2.
    clock.advance(20);
    session.pushAudio(speechFrame());

    const interruptions = events.filter((e) => e.type === 'interrupted');
    expect(interruptions).toHaveLength(2);
    expect(interruptions[1]).toMatchObject({ text: 'Second reply. [interrupted]' });

    gate2.resolve();
    await session.idle();
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

describe('VoiceSession — stop()', () => {
  // Bug: closing a browser tab (or tearing down a SIP/LiveKit call) had no way
  // to tell VoiceSession to stop. `pushAudio` fires `handleUtterance`/
  // `runTurn` as a detached async operation, so a caller that only dropped
  // its reference (the old `VoiceLane.close()`/`VoiceChannelAdapter.stop()`
  // posture) left the in-flight LLM turn, STT call and TTS synthesis running
  // to completion with nobody listening — real cost exposure with no way to
  // stop it short of the whole process dying.
  it('aborts the in-flight turn and cancels playout without emitting interrupted or reply_complete', async () => {
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
    await tick();

    session.stop();

    // Nothing was emitted for the stop itself — no `interrupted`, and once the
    // aborted runner unwinds, no `reply_complete` either.
    expect(events.some((e) => e.type === 'interrupted')).toBe(false);
    gate.resolve();
    await session.idle();

    expect(secondYielded).toBe(false); // the turn was aborted before the 2nd sentence
    expect(events.some((e) => e.type === 'reply_complete')).toBe(false);
    expect(events.some((e) => e.type === 'interrupted')).toBe(false);
  });

  it('is idempotent and safe to call on a session with no turn in flight', () => {
    const clock = makeClock();
    const session = new VoiceSession({
      runner: scriptedRunner([]),
      stt: streamingStt('hi'),
      tts: streamingTts(),
      vad: new FakeVad(),
      now: clock.now,
    });
    expect(() => {
      session.stop();
      session.stop();
    }).not.toThrow();
  });

  it('clears a pending filler debounce and tick interval', async () => {
    const clock = new FakeTimerClock();
    const gate = deferred();
    const runner: AgentTurnRunner = {
      async *run(): AsyncGenerator<AgentEvent> {
        yield { type: 'tool_start', toolCallId: 't1', toolName: 'search', args: {} };
        await gate.promise;
        yield { type: 'tool_end', toolCallId: 't1', toolName: 'search', ok: true, durationMs: 5 };
      },
    };
    const session = new VoiceSession({
      runner,
      stt: streamingStt('hi'),
      tts: streamingTts(),
      vad: new FakeVad(),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      config: { fillerAfterMs: 50, tickIntervalMs: 60 },
    });
    const events = collect(session);

    feed(session, clock, speechFrame(), 5);
    feed(session, clock, silenceFrame(), 30);
    await waitForTimer(clock);
    expect(clock.hasPending()).toBe(true);

    session.stop();

    expect(clock.hasPending()).toBe(false);
    expect(events.some((e) => e.type === 'filler')).toBe(false);
    expect(events.some((e) => e.type === 'tick')).toBe(false);
    gate.resolve();
  });
});

describe('VoiceSession — tool-call filler and tick', () => {
  it('speaks the filler once a tool call outlasts the debounce', async () => {
    const clock = new FakeTimerClock();
    const gate = deferred();
    const runner: AgentTurnRunner = {
      async *run(): AsyncGenerator<AgentEvent> {
        yield { type: 'tool_start', toolCallId: 't1', toolName: 'search', args: {} };
        await gate.promise;
        yield { type: 'tool_end', toolCallId: 't1', toolName: 'search', ok: true, durationMs: 5 };
        yield { type: 'text_delta', text: 'Found it.' };
      },
    };
    const session = new VoiceSession({
      runner,
      stt: streamingStt('search for something'),
      tts: streamingTts(),
      vad: new FakeVad(),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      config: { fillerAfterMs: 600, fillerText: 'Let me check that.' },
    });
    const events = collect(session);

    speakUtterance(session, clock);
    await waitForTimer(clock); // the filler debounce is now armed

    clock.advance(600);
    expect(events.find((e) => e.type === 'filler')).toMatchObject({ text: 'Let me check that.' });

    gate.resolve();
    await session.idle();

    expect(events.find((e) => e.type === 'reply_complete')).toBeTruthy();
  });

  it('does not speak the filler when the tool finishes before the debounce elapses', async () => {
    const clock = new FakeTimerClock();
    const gate = deferred();
    const runner: AgentTurnRunner = {
      async *run(): AsyncGenerator<AgentEvent> {
        yield { type: 'tool_start', toolCallId: 't1', toolName: 'search', args: {} };
        await gate.promise;
        yield { type: 'tool_end', toolCallId: 't1', toolName: 'search', ok: true, durationMs: 5 };
        yield { type: 'text_delta', text: 'Found it.' };
      },
    };
    const session = new VoiceSession({
      runner,
      stt: streamingStt('search for something'),
      tts: streamingTts(),
      vad: new FakeVad(),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      config: { fillerAfterMs: 600, fillerText: 'Let me check that.' },
    });
    const events = collect(session);

    speakUtterance(session, clock);
    await waitForTimer(clock); // the filler debounce is armed…

    gate.resolve(); // …but the tool finishes right away
    await tick();
    await tick();

    // Only now does the debounce window elapse — too late, it was cancelled.
    clock.advance(600);
    await session.idle();

    expect(events.find((e) => e.type === 'filler')).toBeUndefined();
    expect(events.find((e) => e.type === 'reply_complete')).toMatchObject({ text: 'Found it.' });
  });

  it('does not speak the filler when reply text already started before the tool call', async () => {
    const clock = new FakeTimerClock();
    const gate = deferred();
    const runner: AgentTurnRunner = {
      async *run(): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', text: 'Let me look. ' };
        yield { type: 'tool_start', toolCallId: 't1', toolName: 'search', args: {} };
        await gate.promise;
        yield { type: 'tool_end', toolCallId: 't1', toolName: 'search', ok: true, durationMs: 5 };
        yield { type: 'text_delta', text: 'Found it.' };
      },
    };
    const session = new VoiceSession({
      runner,
      stt: streamingStt('search for something'),
      tts: streamingTts(),
      vad: new FakeVad(),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      config: { fillerAfterMs: 600 },
    });
    const events = collect(session);

    speakUtterance(session, clock);
    await tick();
    await tick();
    // No timer is armed at all — text already resumed before this tool call.
    expect(clock.hasPending()).toBe(false);

    gate.resolve();
    await session.idle();

    expect(events.find((e) => e.type === 'filler')).toBeUndefined();
  });

  it('ticks at the configured interval while a tool is in flight, and stops the instant it ends', async () => {
    const clock = new FakeTimerClock();
    const gate = deferred();
    const runner: AgentTurnRunner = {
      async *run(): AsyncGenerator<AgentEvent> {
        yield { type: 'tool_start', toolCallId: 't1', toolName: 'search', args: {} };
        await gate.promise;
        yield { type: 'tool_end', toolCallId: 't1', toolName: 'search', ok: true, durationMs: 5 };
        yield { type: 'text_delta', text: 'Found it.' };
      },
    };
    const session = new VoiceSession({
      runner,
      stt: streamingStt('search for something'),
      tts: streamingTts(),
      vad: new FakeVad(),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      config: { tickIntervalMs: 1000 },
    });
    const events = collect(session);
    const ticks = (): number => events.filter((e) => e.type === 'tick').length;

    speakUtterance(session, clock);
    await waitForTimer(clock);

    clock.advance(1000);
    expect(ticks()).toBe(1);
    clock.advance(1000);
    expect(ticks()).toBe(2);

    gate.resolve(); // the tool ends
    await tick();
    await tick();

    // Ticking has stopped — advancing well past several more intervals must
    // not add any more.
    clock.advance(5000);
    expect(ticks()).toBe(2);

    await session.idle();
    expect(events.find((e) => e.type === 'reply_complete')).toMatchObject({ text: 'Found it.' });
  });

  it('stops ticking the instant reply text resumes', async () => {
    const clock = new FakeTimerClock();
    const gate = deferred();
    const runner: AgentTurnRunner = {
      async *run(): AsyncGenerator<AgentEvent> {
        yield { type: 'tool_start', toolCallId: 't1', toolName: 'search', args: {} };
        await gate.promise;
        // Text resumes without an explicit `tool_end` — the stop-on-text path
        // must not depend on the tool count reaching zero first.
        yield { type: 'text_delta', text: 'Found it.' };
      },
    };
    const session = new VoiceSession({
      runner,
      stt: streamingStt('search for something'),
      tts: streamingTts(),
      vad: new FakeVad(),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      config: { tickIntervalMs: 1000 },
    });
    const events = collect(session);
    const ticks = (): number => events.filter((e) => e.type === 'tick').length;

    speakUtterance(session, clock);
    await waitForTimer(clock);
    clock.advance(1000);
    expect(ticks()).toBe(1);

    gate.resolve();
    await tick();
    await tick();

    clock.advance(5000);
    expect(ticks()).toBe(1);

    await session.idle();
  });

  it('stops ticking on barge-in', async () => {
    const clock = new FakeTimerClock();
    const gate = deferred();
    const runner: AgentTurnRunner = {
      async *run(_text, opts): AsyncGenerator<AgentEvent> {
        yield { type: 'tool_start', toolCallId: 't1', toolName: 'search', args: {} };
        await gate.promise;
        if (opts?.abortSignal?.aborted) return;
        yield { type: 'tool_end', toolCallId: 't1', toolName: 'search', ok: true, durationMs: 5 };
        yield { type: 'text_delta', text: 'Found it.' };
      },
    };
    const session = new VoiceSession({
      runner,
      stt: streamingStt('search for something'),
      tts: streamingTts(),
      vad: new FakeVad(),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      config: { tickIntervalMs: 1000 },
    });
    const events = collect(session);
    const ticks = (): number => events.filter((e) => e.type === 'tick').length;

    speakUtterance(session, clock);
    await waitForTimer(clock);
    clock.advance(1000);
    expect(ticks()).toBe(1);

    // User speaks over the (silent, tool-running) turn -> barge-in.
    clock.advance(20);
    session.pushAudio(speechFrame());
    expect(events.find((e) => e.type === 'interrupted')).toBeTruthy();

    clock.advance(5000);
    expect(ticks()).toBe(1);

    gate.resolve(); // let the (now-aborted) runner unwind
    await session.idle();
  });
});
