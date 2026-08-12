import {
  encodeVoiceFrame,
  VOICE_SOCKET_PATH,
  type VoiceServerFrame,
} from '@ethosagent/web-contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  createVoiceSocketTransport,
  type VoiceSocketLike,
  type VoiceTransportStatus,
  voiceSocketUrl,
} from '../voice-socket-transport';

/** A hand-driven stand-in for the browser's WebSocket. */
class FakeSocket implements VoiceSocketLike {
  static readonly instances: FakeSocket[] = [];
  binaryType = '';
  readyState = 0;
  readonly sent: Uint8Array[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: ArrayBufferView | ArrayBuffer): void {
    this.sent.push(
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(
            (data as ArrayBufferView).buffer,
            (data as ArrayBufferView).byteOffset,
            (data as ArrayBufferView).byteLength,
          ),
    );
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  deliver(frame: VoiceServerFrame, payload?: Uint8Array): void {
    const bytes = encodeVoiceFrame(frame, payload);
    this.onmessage?.({ data: bytes.buffer.slice(0) });
  }
}

function harness(reconnectDelaysMs = [10]) {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const transport = createVoiceSocketTransport({
    url: 'ws://localhost:3000/voice/ws',
    reconnectDelaysMs,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    schedule: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length - 1;
    },
    cancelSchedule: () => {},
  });
  const statuses: VoiceTransportStatus[] = [];
  transport.onStatus((status) => statuses.push(status));
  return { transport, sockets, timers, statuses };
}

describe('voice socket transport', () => {
  it('builds a same-origin lane URL matching the page scheme', () => {
    expect(voiceSocketUrl({ protocol: 'http:', host: 'localhost:3000' })).toBe(
      `ws://localhost:3000${VOICE_SOCKET_PATH}`,
    );
    expect(voiceSocketUrl({ protocol: 'https:', host: 'ethos.example' })).toBe(
      `wss://ethos.example${VOICE_SOCKET_PATH}`,
    );
  });

  it('resolves connect on open and encodes outbound frames', async () => {
    const { transport, sockets } = harness();
    const connected = transport.connect();
    sockets[0]?.open();
    await connected;

    transport.send({ t: 'utterance_start', utteranceId: 'u1', sampleRate: 16_000 });
    expect(sockets[0]?.binaryType).toBe('arraybuffer');
    expect(sockets[0]?.sent).toHaveLength(1);
    expect(transport.status).toBe('open');
  });

  it('parses inbound frames and ignores unparseable ones', async () => {
    const { transport, sockets } = harness();
    const connected = transport.connect();
    sockets[0]?.open();
    await connected;

    const seen: VoiceServerFrame[] = [];
    transport.on((frame) => seen.push(frame));
    sockets[0]?.deliver({ t: 'transcript', utteranceId: 'u1', text: 'hi', final: true });
    sockets[0]?.onmessage?.({ data: new Uint8Array([9, 9, 9]).buffer });
    sockets[0]?.onmessage?.({ data: 'a text frame' });

    expect(seen).toEqual([{ t: 'transcript', utteranceId: 'u1', text: 'hi', final: true }]);
  });

  it('reconnects after an unexpected drop', async () => {
    const { transport, sockets, timers, statuses } = harness([10]);
    const connected = transport.connect();
    sockets[0]?.open();
    await connected;

    sockets[0]?.drop();
    expect(statuses).toContain('reconnecting');
    expect(timers).toHaveLength(1);

    timers[0]?.fn();
    sockets[1]?.open();
    expect(transport.status).toBe('open');
    expect(sockets).toHaveLength(2);
  });

  it('does not reconnect after an explicit close', async () => {
    const { transport, sockets, timers } = harness([10]);
    const connected = transport.connect();
    sockets[0]?.open();
    await connected;

    transport.close();
    expect(sockets[0]?.closed).toBe(true);
    expect(timers).toHaveLength(0);
    expect(transport.status).toBe('closed');
  });

  it('rejects connect when the first attempt never opens', async () => {
    const { transport, sockets } = harness();
    const connected = transport.connect();
    sockets[0]?.drop();
    await expect(connected).rejects.toThrow(/voice link/i);
  });

  it('drops frames sent while the link is down rather than queueing them', async () => {
    const { transport, sockets } = harness([10]);
    const connected = transport.connect();
    sockets[0]?.open();
    await connected;
    sockets[0]?.drop();

    transport.send({ t: 'audio', utteranceId: 'u1', seq: 0 }, new Uint8Array([1, 2]));
    expect(sockets[0]?.sent).toHaveLength(0);
  });

  it('notifies listeners of every status change once', async () => {
    const { transport, sockets, statuses } = harness([10]);
    const connected = transport.connect();
    sockets[0]?.open();
    await connected;
    transport.close();
    expect(statuses).toEqual(['connecting', 'open', 'closed']);
    // A duplicate close does not re-notify.
    transport.close();
    expect(statuses).toEqual(['connecting', 'open', 'closed']);
  });

  it('unsubscribes cleanly', async () => {
    const { transport, sockets } = harness();
    const connected = transport.connect();
    sockets[0]?.open();
    await connected;
    const listener = vi.fn();
    const off = transport.on(listener);
    off();
    sockets[0]?.deliver({ t: 'ready', laneId: 'lane-1', protocolVersion: 1 });
    expect(listener).not.toHaveBeenCalled();
  });
});
