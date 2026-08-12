import { describe, expect, it, vi } from 'vitest';
import {
  createTalkModeClient,
  streamingTalkModeSupported,
  type TalkModeEnvironment,
} from '../talk-mode-client';

const full: TalkModeEnvironment = {
  hasWebSocket: true,
  hasAudioContext: true,
  hasMediaDevices: true,
  hasScriptProcessor: true,
};

describe('talk-mode transport selection', () => {
  it('takes the streaming path only when every piece is present', () => {
    expect(streamingTalkModeSupported(full)).toBe(true);
    for (const missing of Object.keys(full) as Array<keyof TalkModeEnvironment>) {
      expect(streamingTalkModeSupported({ ...full, [missing]: false })).toBe(false);
    }
  });

  it('falls back to the batch client when the browser cannot stream', async () => {
    // The batch client is identified by its dependency on `transcribe`: it is
    // the only path that transcribes a whole captured utterance over RPC.
    const transcribe = vi.fn(() => Promise.resolve('hello'));
    const client = createTalkModeClient({
      transcribe,
      runAgentTurn: async function* () {
        yield 'hi';
      },
      environment: { ...full, hasMediaDevices: false },
      createDriver: () => fakeDriver(),
    });
    await client.connect();
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalled());
    await client.disconnect();
  });

  it('honours forceBatch even on a capable browser', async () => {
    const transcribe = vi.fn(() => Promise.resolve('hello'));
    const client = createTalkModeClient({
      transcribe,
      runAgentTurn: async function* () {
        yield 'hi';
      },
      environment: full,
      forceBatch: true,
      createDriver: () => fakeDriver(),
    });
    await client.connect();
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalled());
    await client.disconnect();
  });
});

/** Minimal driver so the batch client can run one utterance in node. */
function fakeDriver() {
  let delivered = false;
  return {
    start: () => Promise.resolve(),
    micStream: () => null,
    setMicEnabled: () => {},
    captureUtterance: (signal: AbortSignal) => {
      if (delivered) {
        return new Promise<null>((resolve) => {
          if (signal.aborted) resolve(null);
          else signal.addEventListener('abort', () => resolve(null), { once: true });
        });
      }
      delivered = true;
      return Promise.resolve({ audioBase64: 'AAA', mimeType: 'audio/webm' });
    },
    play: () => Promise.resolve(),
    playEarcon: () => {},
    onBargeIn: () => () => {},
    setBargeInEnabled: () => {},
    stopPlayback: () => {},
    stop: () => Promise.resolve(),
  };
}
