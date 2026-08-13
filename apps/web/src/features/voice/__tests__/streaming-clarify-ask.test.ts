import { describe, expect, it, vi } from 'vitest';
import {
  createStreamingVoiceCallClient,
  type StreamingVoiceCallDeps,
} from '../streaming-voice-call-client';
import type { VoiceCallEvent } from '../voice-call-client';
import { FakePlayout, FakeVoiceCapture, FakeVoiceTransport } from './streaming-fakes';

// `ask()` on the streaming tier — voice-native `clarify`.
//
// The situation every test here sets up is the only one the method exists for:
// a turn is RUNNING and parked (the agent is blocked inside the `clarify` tool),
// so the question has to be spoken and answered without the client doing either
// of the two things it normally does when the user talks — supersede the
// utterance, or start a new turn.

/** An agent turn that never finishes on its own — the parked `clarify` tool. */
function parkedTurn(): { calls: () => number; run: StreamingVoiceCallDeps['runAgentTurn'] } {
  let calls = 0;
  return {
    calls: () => calls,
    run: async function* () {
      calls++;
      await new Promise<void>(() => {});
    },
  };
}

function setup(overrides: Partial<StreamingVoiceCallDeps> = {}) {
  const transport = new FakeVoiceTransport();
  const capture = new FakeVoiceCapture();
  const playout = new FakePlayout();
  const events: VoiceCallEvent[] = [];
  let n = 0;
  const client = createStreamingVoiceCallClient({
    transport,
    capture,
    playout,
    runAgentTurn: async function* () {
      yield 'ok';
    },
    newUtteranceId: () => `u${++n}`,
    ...overrides,
  });
  client.on((event) => events.push(event));
  return { transport, capture, playout, client, events };
}

/** Drive the client to "a turn is running and parked on this utterance". */
async function reachParkedTurn(harness: ReturnType<typeof setup>): Promise<void> {
  await harness.client.connect();
  harness.capture.speakUtterance();
  harness.transport.deliver({ t: 'transcript', utteranceId: 'u1', text: 'deploy it', final: true });
  await vi.waitFor(() => expect(harness.capture.captureEnabled).toBe(false));
}

/** Answer the question's synthesis the way the lane does for PCM. */
function speakQuestion(harness: ReturnType<typeof setup>, segmentId = 'q0'): void {
  harness.transport.deliver(
    {
      t: 'audio',
      utteranceId: 'u1',
      segmentId,
      seq: 0,
      codec: 'pcm_s16le',
      mimeType: 'audio/pcm',
      sampleRate: 24_000,
      provider: 'openai',
    },
    new Uint8Array([0, 0, 0, 0]),
  );
  harness.transport.deliver({ t: 'segment_end', utteranceId: 'u1', segmentId });
  harness.playout.finishAll();
}

describe('streaming talk-mode — ask() speaks a clarify question', () => {
  it('speaks it on the running turn’s utterance and only then opens the mic', async () => {
    const turn = parkedTurn();
    const harness = setup({ runAgentTurn: turn.run, voice: 'alloy', personalityId: 'ripley' });
    await reachParkedTurn(harness);

    const answer = harness.client.ask?.('Staging or production?', new AbortController().signal);

    // Sent as a segment of the utterance the parked turn owns — a fresh id
    // would supersede that turn on the lane and cancel the tool waiting on it.
    await vi.waitFor(() => expect(harness.transport.frames('synthesize')).toHaveLength(1));
    expect(harness.transport.frames('synthesize')[0]).toEqual({
      t: 'synthesize',
      utteranceId: 'u1',
      segmentId: 'q0',
      text: 'Staging or production?',
      voice: 'alloy',
      personalityId: 'ripley',
    });
    // Still the agent-speaking gating while it plays: closed mic, barge-in
    // armed — the question must not be heard as its own answer.
    expect(harness.capture.captureEnabled).toBe(false);
    expect(harness.capture.bargeEnabled).toBe(true);

    speakQuestion(harness);

    // Said. The floor goes back: capture on, barge-in off (nothing to interrupt).
    await vi.waitFor(() => expect(harness.capture.captureEnabled).toBe(true));
    expect(harness.capture.bargeEnabled).toBe(false);

    harness.capture.speakUtterance();
    // The answer reopens the SAME utterance and sends no cancel — the turn the
    // answer is for is still running.
    expect(harness.transport.frames('utterance_start')).toEqual([
      { t: 'utterance_start', utteranceId: 'u1', personalityId: 'ripley', sampleRate: 16_000 },
      { t: 'utterance_start', utteranceId: 'u1', personalityId: 'ripley', sampleRate: 16_000 },
    ]);
    expect(harness.transport.frames('cancel')).toHaveLength(0);

    harness.transport.deliver({
      t: 'transcript',
      utteranceId: 'u1',
      text: '  production  ',
      final: true,
    });

    // The answer resolves the ask instead of starting a second chat turn.
    await expect(answer).resolves.toBe('production');
    expect(turn.calls()).toBe(1);
    // …and the agent takes the floor back for the reply it is about to give.
    expect(harness.capture.captureEnabled).toBe(false);
    expect(harness.capture.bargeEnabled).toBe(true);
  });

  it('captions the question and hands the floor over in the transcript', async () => {
    const harness = setup({ runAgentTurn: parkedTurn().run });
    await reachParkedTurn(harness);
    const answer = harness.client.ask?.('Which region?', new AbortController().signal);
    await vi.waitFor(() => expect(harness.transport.frames('synthesize')).toHaveLength(1));
    speakQuestion(harness);
    await vi.waitFor(() => expect(harness.capture.captureEnabled).toBe(true));

    const spoken = harness.events.filter((e) => e.type === 'reply_sentence');
    expect(spoken).toEqual([{ type: 'reply_sentence', text: 'Which region?' }]);
    expect(harness.events.at(-1)).toEqual({ type: 'reply_complete', text: 'Which region?' });

    harness.transport.deliver({ t: 'transcript', utteranceId: 'u1', text: 'eu-west', final: true });
    await expect(answer).resolves.toBe('eu-west');
    // The answer is a user line like any other spoken turn.
    expect(harness.events.filter((e) => e.type === 'utterance_committed')).toHaveLength(2);
  });

  it('keeps listening when the answer comes back empty', async () => {
    const harness = setup({ runAgentTurn: parkedTurn().run });
    await reachParkedTurn(harness);
    const answer = harness.client.ask?.('Which region?', new AbortController().signal);
    await vi.waitFor(() => expect(harness.transport.frames('synthesize')).toHaveLength(1));
    speakQuestion(harness);
    await vi.waitFor(() => expect(harness.capture.captureEnabled).toBe(true));

    harness.capture.speakUtterance();
    harness.transport.deliver({ t: 'transcript', utteranceId: 'u1', text: '   ', final: true });
    expect(harness.events.at(-1)).toEqual({ type: 'utterance_dropped' });
    expect(harness.capture.captureEnabled).toBe(true);

    harness.transport.deliver({ t: 'transcript', utteranceId: 'u1', text: 'eu-west', final: true });
    await expect(answer).resolves.toBe('eu-west');
  });

  it('gives up on a question the lane could not synthesize, and keeps the turn', async () => {
    const turn = parkedTurn();
    const harness = setup({ runAgentTurn: turn.run });
    await reachParkedTurn(harness);
    const answer = harness.client.ask?.('Which region?', new AbortController().signal);
    await vi.waitFor(() => expect(harness.transport.frames('synthesize')).toHaveLength(1));

    harness.transport.deliver({
      t: 'error',
      code: 'synthesize_failed',
      message: 'TTS provider refused',
      utteranceId: 'u1',
      provider: 'elevenlabs',
    });

    // Null, so the caller never arms "the next thing you say answers this".
    await expect(answer).resolves.toBeNull();
    // The mic stays closed: the turn is untouched and still has the floor.
    expect(harness.capture.captureEnabled).toBe(false);
    expect(harness.capture.bargeEnabled).toBe(true);
    // Surfaced WITHOUT the degrading code — one line that could not be spoken
    // is not "voice is unusable", and ending the call here would take the card
    // the user can still answer with off the screen.
    expect(harness.events.at(-1)).toEqual({
      type: 'error',
      error: 'TTS provider refused',
      provider: 'elevenlabs',
    });
    expect(harness.transport.frames('cancel')).toHaveLength(0);
  });

  it('resolves null when the card was answered first, and restores the gating', async () => {
    const harness = setup({ runAgentTurn: parkedTurn().run });
    await reachParkedTurn(harness);
    const controller = new AbortController();
    const answer = harness.client.ask?.('Which region?', controller.signal);
    await vi.waitFor(() => expect(harness.transport.frames('synthesize')).toHaveLength(1));
    speakQuestion(harness);
    await vi.waitFor(() => expect(harness.capture.captureEnabled).toBe(true));

    controller.abort();

    await expect(answer).resolves.toBeNull();
    expect(harness.capture.captureEnabled).toBe(false);
    expect(harness.capture.bargeEnabled).toBe(true);
  });

  it('refuses when there is no turn to ask inside', async () => {
    const harness = setup();
    await harness.client.connect();

    await expect(
      harness.client.ask?.('Which region?', new AbortController().signal),
    ).resolves.toBeNull();
    expect(harness.transport.frames('synthesize')).toHaveLength(0);
  });

  it('ends the ask when the call is hung up mid-question', async () => {
    const harness = setup({ runAgentTurn: parkedTurn().run });
    await reachParkedTurn(harness);
    const answer = harness.client.ask?.('Which region?', new AbortController().signal);
    await vi.waitFor(() => expect(harness.transport.frames('synthesize')).toHaveLength(1));

    await harness.client.disconnect();

    await expect(answer).resolves.toBeNull();
  });
});
