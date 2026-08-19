import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runBrowserVoiceTurn } from '../browser-voice-turn';

// Bug 4: the batch-RPC fallback tier used to drive its turn through the
// CHAT session (`chat-voice-runner.ts`'s `runVoiceAgentTurn`, which called
// the chat hook's `sendMessage` and tapped its SSE) — the exact anti-pattern
// `plan/phases/voice-live-personality.md` §7 "Conflict 1" locks against.
// This proves the replacement calls `voice.runTurn` (the browser-voice-lane
// RPC), never anything chat-session-shaped.

const runTurnMock = vi.fn();
vi.mock('../../../rpc', () => ({
  rpc: { voice: { runTurn: (...args: unknown[]) => runTurnMock(...args) } },
}));

describe('runBrowserVoiceTurn', () => {
  beforeEach(() => {
    runTurnMock.mockReset();
  });

  it('calls voice.runTurn with the voice-lane sessionId and yields the reply as one chunk', async () => {
    runTurnMock.mockResolvedValueOnce({ reply: 'Clear skies.' });
    const chunks: string[] = [];
    for await (const chunk of runBrowserVoiceTurn('weather?', new AbortController().signal, {
      sessionId: () => 'chat-9',
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['Clear skies.']);
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    expect(runTurnMock).toHaveBeenCalledWith(
      { text: 'weather?', sessionId: 'chat-9' },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('forwards personalityId when the active personality is known', async () => {
    runTurnMock.mockResolvedValueOnce({ reply: 'ok' });
    for await (const _chunk of runBrowserVoiceTurn('hi', new AbortController().signal, {
      sessionId: () => 'chat-9',
      personalityId: 'researcher',
    })) {
      // drain
    }

    expect(runTurnMock).toHaveBeenCalledWith(
      { text: 'hi', sessionId: 'chat-9', personalityId: 'researcher' },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('forwards the caller-provided abort signal to the RPC call', async () => {
    runTurnMock.mockResolvedValueOnce({ reply: 'ok' });
    const controller = new AbortController();
    for await (const _chunk of runBrowserVoiceTurn('hi', controller.signal, {
      sessionId: () => 'chat-9',
    })) {
      // drain
    }

    const passedOptions = runTurnMock.mock.calls[0]?.[1] as { signal?: AbortSignal };
    expect(passedOptions.signal).toBe(controller.signal);
  });

  it('never calls the RPC when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const chunks: string[] = [];
    for await (const chunk of runBrowserVoiceTurn('hi', controller.signal, {
      sessionId: () => 'chat-9',
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([]);
    expect(runTurnMock).not.toHaveBeenCalled();
  });

  it('yields nothing for an empty reply', async () => {
    runTurnMock.mockResolvedValueOnce({ reply: '' });
    const chunks: string[] = [];
    for await (const chunk of runBrowserVoiceTurn('hi', new AbortController().signal, {
      sessionId: () => 'chat-9',
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([]);
  });
});
