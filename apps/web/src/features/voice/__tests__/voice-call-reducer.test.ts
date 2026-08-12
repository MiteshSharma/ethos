import { describe, expect, it } from 'vitest';
import { parseVoiceCallControlEvent, type VoiceCallEvent } from '../voice-call-client';
import {
  initialVoiceCallState,
  MIC_DENIED_CODE,
  type VoiceCallState,
  voiceCallReducer,
  voiceCaption,
  voiceTranscriptToMessages,
} from '../voice-call-reducer';
import { FakeVoiceCallClient } from './fake-voice-call-client';

// Reduce a whole event sequence — the shape the hook feeds the reducer.
function reduce(events: Array<Parameters<typeof voiceCallReducer>[1]>): VoiceCallState {
  return events.reduce(voiceCallReducer, initialVoiceCallState);
}

// Drive the reducer through a FakeVoiceCallClient's event stream, exactly as the
// hook does (subscribe -> dispatch 'client-event').
function driveThroughClient(events: VoiceCallEvent[]): VoiceCallState {
  const client = new FakeVoiceCallClient();
  let state: VoiceCallState = { ...initialVoiceCallState, status: 'listening' };
  const unsubscribe = client.on((event) => {
    state = voiceCallReducer(state, { type: 'client-event', event });
  });
  for (const event of events) client.emit(event);
  unsubscribe();
  return state;
}

describe('voiceCallReducer — connection lifecycle', () => {
  it('goes idle -> connecting -> listening', () => {
    const connecting = voiceCallReducer(initialVoiceCallState, { type: 'start' });
    expect(connecting.status).toBe('connecting');
    const listening = voiceCallReducer(connecting, { type: 'connected' });
    expect(listening.status).toBe('listening');
  });

  it('start clears a prior transcript, error and notices', () => {
    const dirty: VoiceCallState = {
      ...initialVoiceCallState,
      status: 'ended',
      transcript: [{ id: 'voice-0', role: 'user', text: 'old' }],
      error: 'boom',
      degraded: { provider: 'openai-tts', message: 'boom' },
      micDenied: true,
      sttProvider: 'local-stt',
    };
    const fresh = voiceCallReducer(dirty, { type: 'start' });
    expect(fresh).toEqual({ ...initialVoiceCallState, status: 'connecting' });
  });

  it('hang-up ends the call; reset returns to idle', () => {
    const ended = voiceCallReducer(
      { ...initialVoiceCallState, status: 'listening' },
      {
        type: 'hang-up',
      },
    );
    expect(ended.status).toBe('ended');
    expect(voiceCallReducer(ended, { type: 'reset' })).toEqual(initialVoiceCallState);
  });

  it('a disconnected event ends the call', () => {
    const state = driveThroughClient([{ type: 'disconnected' }]);
    expect(state.status).toBe('ended');
  });
});

describe('voiceCallReducer — transcript', () => {
  it('appends a user line on utterance_committed and enters thinking', () => {
    const state = driveThroughClient([{ type: 'utterance_committed', text: 'what time is it' }]);
    // The gap between "you stopped talking" and "it started answering" is its
    // own state (DR1 thinking) — the accent dot goes steady, not back to a mic.
    expect(state.status).toBe('thinking');
    expect(state.transcript).toEqual([{ id: 'voice-0', role: 'user', text: 'what time is it' }]);
  });

  it('accumulates reply sentences into one open agent line', () => {
    const state = driveThroughClient([
      { type: 'utterance_committed', text: 'hi' },
      { type: 'reply_sentence', text: 'Hello there.' },
      { type: 'reply_sentence', text: 'How can I help?' },
    ]);
    expect(state.status).toBe('agent_speaking');
    expect(state.transcript).toEqual([
      { id: 'voice-0', role: 'user', text: 'hi' },
      { id: 'voice-1', role: 'agent', text: 'Hello there. How can I help?', open: true },
    ]);
  });

  it('finalizes the agent line on reply_complete', () => {
    const state = driveThroughClient([
      { type: 'utterance_committed', text: 'hi' },
      { type: 'reply_sentence', text: 'Hello there.' },
      { type: 'reply_complete', text: 'Hello there. Full reply.' },
    ]);
    expect(state.status).toBe('listening');
    expect(state.transcript[1]).toEqual({
      id: 'voice-1',
      role: 'agent',
      text: 'Hello there. Full reply.',
      open: false,
    });
  });

  it('a fresh user utterance opens a new agent line for the next reply', () => {
    const state = driveThroughClient([
      { type: 'utterance_committed', text: 'q1' },
      { type: 'reply_sentence', text: 'a1' },
      { type: 'reply_complete', text: 'a1' },
      { type: 'utterance_committed', text: 'q2' },
      { type: 'reply_sentence', text: 'a2' },
    ]);
    expect(state.transcript.map((l) => `${l.role}:${l.text}`)).toEqual([
      'user:q1',
      'agent:a1',
      'user:q2',
      'agent:a2',
    ]);
  });

  it('renders a spoken filler as its own agent line', () => {
    const state = driveThroughClient([
      { type: 'utterance_committed', text: 'do the thing' },
      { type: 'filler', text: 'One moment.' },
      { type: 'reply_sentence', text: 'Done.' },
    ]);
    expect(state.transcript).toEqual([
      { id: 'voice-0', role: 'user', text: 'do the thing' },
      { id: 'voice-1', role: 'agent', text: 'One moment.', filler: true },
      { id: 'voice-2', role: 'agent', text: 'Done.', open: true },
    ]);
  });

  it('reply_audio marks the agent speaking without touching the transcript', () => {
    const before = driveThroughClient([{ type: 'utterance_committed', text: 'hi' }]);
    const after = voiceCallReducer(before, {
      type: 'client-event',
      event: { type: 'reply_audio', audio: new Uint8Array([1, 2]), format: 'opus' },
    });
    expect(after.status).toBe('agent_speaking');
    expect(after.transcript).toEqual(before.transcript);
  });
});

describe('voiceCallReducer — barge-in', () => {
  it('marks the interrupted agent line and enters the interrupted state', () => {
    const state = driveThroughClient([
      { type: 'utterance_committed', text: 'tell me a long story' },
      { type: 'reply_sentence', text: 'Once upon a time' },
      { type: 'interrupted', text: 'Once upon a time [interrupted]' },
    ]);
    expect(state.status).toBe('interrupted');
    expect(state.transcript[1]).toEqual({
      id: 'voice-1',
      role: 'agent',
      text: 'Once upon a time [interrupted]',
      interrupted: true,
      open: false,
    });
  });

  it('leaves the interrupted state when the user speaks over the interruption', () => {
    const state = driveThroughClient([
      { type: 'utterance_committed', text: 'story please' },
      { type: 'reply_sentence', text: 'Once' },
      { type: 'interrupted', text: 'Once [interrupted]' },
      { type: 'utterance_committed', text: 'actually never mind' },
    ]);
    expect(state.status).toBe('thinking');
    expect(state.transcript[2]).toEqual({
      id: 'voice-2',
      role: 'user',
      text: 'actually never mind',
    });
  });
});

describe('voiceCallReducer — errors', () => {
  it('surfaces a recoverable error without changing status', () => {
    const listening = reduce([{ type: 'start' }, { type: 'connected' }]);
    const withError = voiceCallReducer(listening, {
      type: 'client-event',
      event: { type: 'error', error: 'synthesis failed' },
    });
    expect(withError.status).toBe('listening');
    expect(withError.error).toBe('synthesis failed');
  });
});

describe('voiceTranscriptToMessages', () => {
  it('maps user lines to user bubbles and agent lines to assistant turns', () => {
    const messages = voiceTranscriptToMessages([
      { id: 'voice-0', role: 'user', text: 'hi' },
      { id: 'voice-1', role: 'agent', text: 'hello', open: false },
    ]);
    expect(messages[0]).toEqual({ id: 'voice-0', role: 'user', content: 'hi', timestamp: 0 });
    expect(messages[1]).toEqual({
      id: 'voice-1',
      role: 'assistant',
      blocks: [{ kind: 'text', content: 'hello' }],
      timestamp: 0,
    });
  });

  it('appends the [interrupted] marker when the honest text lacks it', () => {
    const [msg] = voiceTranscriptToMessages([
      { id: 'voice-0', role: 'agent', text: 'partial reply', interrupted: true },
    ]);
    expect(msg).toEqual({
      id: 'voice-0',
      role: 'assistant',
      blocks: [{ kind: 'text', content: 'partial reply [interrupted]' }],
      timestamp: 0,
    });
  });

  it('does not double the marker when the honest text already carries it', () => {
    const [msg] = voiceTranscriptToMessages([
      { id: 'voice-0', role: 'agent', text: 'partial [interrupted]', interrupted: true },
    ]);
    expect(msg?.role === 'assistant' && msg.blocks[0]).toEqual({
      kind: 'text',
      content: 'partial [interrupted]',
    });
  });
});

describe('parseVoiceCallControlEvent (untrusted transport JSON)', () => {
  it('accepts a well-formed control event', () => {
    expect(parseVoiceCallControlEvent({ type: 'reply_sentence', text: 'hi' })).toEqual({
      type: 'reply_sentence',
      text: 'hi',
    });
  });

  it('rejects malformed / unknown payloads with null', () => {
    expect(parseVoiceCallControlEvent({ type: 'reply_sentence' })).toBeNull();
    expect(parseVoiceCallControlEvent({ type: 'nope' })).toBeNull();
    expect(parseVoiceCallControlEvent('garbage')).toBeNull();
  });
});

describe('voiceCallReducer — link state (DR1 reconnecting)', () => {
  it('a dropped link becomes reconnecting, and recovers to listening', () => {
    const dropped = driveThroughClient([{ type: 'link', status: 'reconnecting' }]);
    expect(dropped.status).toBe('reconnecting');
    const back = voiceCallReducer(dropped, {
      type: 'client-event',
      event: { type: 'link', status: 'open' },
    });
    expect(back.status).toBe('listening');
  });

  it('link noise never revives an idle or ended call', () => {
    const idle = voiceCallReducer(initialVoiceCallState, {
      type: 'client-event',
      event: { type: 'link', status: 'reconnecting' },
    });
    expect(idle.status).toBe('idle');
  });
});

describe('voiceCallReducer — degraded to text and mic permission', () => {
  it('a provider failure ends voice and names the provider', () => {
    const state = driveThroughClient([
      {
        type: 'error',
        error: 'Speech synthesis failed',
        code: 'synthesize_failed',
        provider: 'openai-tts',
      },
    ]);
    expect(state.status).toBe('ended');
    expect(state.degraded).toEqual({
      provider: 'openai-tts',
      message: 'Speech synthesis failed',
    });
  });

  it('a refused mic is guidance, not a degraded-provider notice', () => {
    const state = driveThroughClient([
      { type: 'error', error: 'Allow the microphone…', code: MIC_DENIED_CODE },
    ]);
    expect(state.micDenied).toBe(true);
    expect(state.degraded).toBeNull();
  });

  it('dismissing clears both notices without restarting the call', () => {
    const denied = driveThroughClient([
      { type: 'error', error: 'Allow the microphone…', code: MIC_DENIED_CODE },
    ]);
    const dismissed = voiceCallReducer(denied, { type: 'dismiss-notice' });
    expect(dismissed.micDenied).toBe(false);
    expect(dismissed.error).toBeNull();
    expect(dismissed.status).toBe('ended');
  });

  it('an unrecognized error code stays recoverable', () => {
    const state = driveThroughClient([
      { type: 'error', error: 'transient', code: 'utterance_too_long' },
    ]);
    expect(state.degraded).toBeNull();
    expect(state.error).toBe('transient');
  });
});

describe('voiceCallReducer — provider attribution', () => {
  it('records the providers that actually served the turn', () => {
    const state = driveThroughClient([
      { type: 'utterance_committed', text: 'hi', provider: 'local-stt' },
      { type: 'reply_sentence', text: 'Hello.' },
      { type: 'reply_audio', audio: new Uint8Array(), format: 'pcm', provider: 'local-tts' },
    ]);
    expect(state.sttProvider).toBe('local-stt');
    expect(state.ttsProvider).toBe('local-tts');
  });
});

describe('voiceCaption', () => {
  it('captions the agent line while it is speaking', () => {
    const state = driveThroughClient([
      { type: 'utterance_committed', text: 'hi' },
      { type: 'reply_sentence', text: 'Hello there.' },
    ]);
    expect(voiceCaption(state)).toBe('Hello there.');
  });

  it('keeps captioning the interrupted line after barge-in', () => {
    const state = driveThroughClient([
      { type: 'utterance_committed', text: 'story' },
      { type: 'reply_sentence', text: 'Once upon a time' },
      { type: 'interrupted', text: 'Once upon a time' },
    ]);
    expect(voiceCaption(state)).toBe('Once upon a time');
  });

  it('captions nothing while the user has the floor', () => {
    const state = driveThroughClient([{ type: 'utterance_committed', text: 'hi' }]);
    expect(voiceCaption(state)).toBeNull();
  });
});
