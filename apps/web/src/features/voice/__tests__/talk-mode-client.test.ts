import { describe, expect, it, vi } from 'vitest';
import {
  createTalkModeClient,
  realtimeDegradeNotice,
  realtimeTalkModeSupported,
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

describe('talk-mode tier selection', () => {
  it('needs every streaming piece before realtime is even attempted', () => {
    // The realtime tier captures through the same PCM tap and plays out through
    // the same absolute scheduler, so it cannot run where streaming cannot.
    expect(realtimeTalkModeSupported(full)).toBe(true);
    for (const missing of Object.keys(full) as Array<keyof TalkModeEnvironment>) {
      expect(realtimeTalkModeSupported({ ...full, [missing]: false })).toBe(false);
    }
  });

  it('never mints a token on a browser that cannot run the realtime tier', async () => {
    const mintRealtimeToken = vi.fn();
    const transcribe = vi.fn(() => Promise.resolve('hello'));
    const client = createTalkModeClient({
      transcribe,
      runAgentTurn: async function* () {
        yield 'hi';
      },
      environment: { ...full, hasMediaDevices: false },
      mintRealtimeToken,
      createDriver: () => fakeDriver(),
    });
    await client.connect();
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalled());
    expect(mintRealtimeToken).not.toHaveBeenCalled();
    await client.disconnect();
  });

  it('never mints a token when the user chose the private/offline pipeline', async () => {
    // The whole point of private mode: nothing about the conversation — not
    // even the request for a credential — reaches a hosted realtime provider.
    const mintRealtimeToken = vi.fn();
    const transcribe = vi.fn(() => Promise.resolve('hello'));
    const client = createTalkModeClient({
      transcribe,
      runAgentTurn: async function* () {
        yield 'hi';
      },
      environment: { ...full, hasMediaDevices: false },
      forcePipeline: true,
      mintRealtimeToken,
      createDriver: () => fakeDriver(),
    });
    await client.connect();
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalled());
    expect(mintRealtimeToken).not.toHaveBeenCalled();
    await client.disconnect();
  });

  it('reports the tier that actually ran', async () => {
    const tiers: string[] = [];
    const transcribe = vi.fn(() => Promise.resolve('hello'));
    const client = createTalkModeClient({
      transcribe,
      runAgentTurn: async function* () {
        yield 'hi';
      },
      environment: { ...full, hasMediaDevices: false },
      onTier: (tier) => tiers.push(tier),
      createDriver: () => fakeDriver(),
    });
    await client.connect();
    expect(tiers).toEqual(['pipeline']);
    await client.disconnect();
  });
});

describe('realtime refusal → what the user is told', () => {
  const refusal = (reason: string, message: string) =>
    ({ ok: false, reason, message, providerId: null }) as const;

  it('says nothing when the pipeline is what was configured', () => {
    // Not a downgrade: the deployment or the personality asked for this.
    expect(
      realtimeDegradeNotice(refusal('pipeline_preferred', 'Voice is configured to run locally.')),
    ).toBeNull();
    expect(
      realtimeDegradeNotice(refusal('not_configured', 'No realtime voice provider is configured.')),
    ).toBeNull();
  });

  it('names the reason for every refusal that IS a downgrade', () => {
    // "Never a silent downgrade": each of these is a call the user expected to
    // run on the realtime tier and did not.
    for (const reason of [
      'unknown_entry',
      'untrusted_provider',
      'no_browser_token',
      'provider_unavailable',
    ]) {
      expect(realtimeDegradeNotice(refusal(reason, `because ${reason}`))).toBe(`because ${reason}`);
    }
  });

  it('says nothing when a token was actually minted', () => {
    expect(
      realtimeDegradeNotice({
        ok: true,
        providerId: 'openai-realtime',
        model: 'gpt-realtime',
        token: 'ek',
        expiresAt: 0,
        url: 'wss://x',
        inputSampleRate: 24_000,
        outputSampleRate: 24_000,
      }),
    ).toBeNull();
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
