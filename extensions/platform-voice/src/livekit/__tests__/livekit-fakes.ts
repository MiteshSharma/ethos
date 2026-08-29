// Test doubles for the LiveKit transport suites. Not a *.test.ts file, so
// vitest does not run it as a suite. FakeLiveKitRoomClient / FakeTokenMinter
// stand in for the native `@livekit/rtc-node` client and `livekit-server-sdk`
// token minter so a full call can be driven without any real WebRTC/server.

import type {
  LiveKitAudioFrame,
  LiveKitConnectOptions,
  LiveKitRoomClient,
  LiveKitTokenMinter,
} from '../room-client';

export class FakeLiveKitRoomClient implements LiveKitRoomClient {
  connected = false;
  connectOpts: LiveKitConnectOptions | null = null;
  readonly published: LiveKitAudioFrame[] = [];
  private remoteHandlers: Array<(frame: LiveKitAudioFrame) => void> = [];
  private disconnectHandlers: Array<() => void> = [];

  constructor(private readonly identity = 'caller-1') {}

  async connect(opts: LiveKitConnectOptions): Promise<void> {
    this.connected = true;
    this.connectOpts = opts;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.remoteHandlers = [];
    this.disconnectHandlers = [];
  }

  onDisconnected(handler: () => void): () => void {
    this.disconnectHandlers.push(handler);
    return () => {
      this.disconnectHandlers = this.disconnectHandlers.filter((h) => h !== handler);
    };
  }

  onRemoteAudio(handler: (frame: LiveKitAudioFrame) => void): () => void {
    this.remoteHandlers.push(handler);
    return () => {
      this.remoteHandlers = this.remoteHandlers.filter((h) => h !== handler);
    };
  }

  publishAudio(frame: LiveKitAudioFrame): void {
    this.published.push(frame);
  }

  remoteIdentity(): string {
    return this.identity;
  }

  /** Test driver: how many remote-audio subscribers are currently wired. */
  remoteHandlerCount(): number {
    return this.remoteHandlers.length;
  }

  /** Test driver: simulate one inbound audio frame from the participant. */
  emitRemote(frame: LiveKitAudioFrame): void {
    for (const handler of this.remoteHandlers) handler(frame);
  }

  /** Test driver: simulate the caller hanging up / the room closing under us. */
  emitDisconnected(): void {
    this.connected = false;
    for (const handler of [...this.disconnectHandlers]) handler();
  }
}

/**
 * A room client written BEFORE `onDisconnected` existed — the shape every
 * app-supplied binding still has today. Proves the seam stayed optional.
 */
export function legacyRoomClient(): LiveKitRoomClient {
  return {
    connect: async () => {},
    disconnect: async () => {},
    onRemoteAudio: () => () => {},
    publishAudio: () => {},
    remoteIdentity: () => 'legacy-caller',
  };
}

export class FakeTokenMinter implements LiveKitTokenMinter {
  readonly minted: Array<{ roomName: string; identity: string }> = [];

  mint(roomName: string, identity: string): string {
    this.minted.push({ roomName, identity });
    return `fake-token:${roomName}:${identity}`;
  }
}

/** A 48kHz remote speech frame (nonzero samples -> the FakeVad reports speech). */
export function remoteSpeechFrame(len = 960): LiveKitAudioFrame {
  return { samples: new Int16Array(len).fill(12000), sampleRate: 48_000 };
}

/** A 48kHz remote silence frame (all zero -> the FakeVad reports non-speech). */
export function remoteSilenceFrame(len = 960): LiveKitAudioFrame {
  return { samples: new Int16Array(len), sampleRate: 48_000 };
}

/** Pack Int16 samples as little-endian PCM bytes (the OutboundAudioFrame shape). */
export function samplesToPcmBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], true);
  return bytes;
}
