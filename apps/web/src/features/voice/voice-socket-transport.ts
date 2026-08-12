import {
  decodeVoiceServerFrame,
  encodeVoiceFrame,
  VOICE_SOCKET_PATH,
  type VoiceClientFrame,
  type VoiceServerFrame,
} from '@ethosagent/web-contracts';

// Browser end of the persistent binary voice lane. One socket per call, held
// open across utterances — the batch path paid a fresh HTTP request per
// utterance and per sentence, which is the latency this replaces.
//
// The socket itself is injected (`createSocket`) so the transport's reconnect
// and framing behavior is testable in node without a real WebSocket.

/** The slice of `WebSocket` this module uses. */
export interface VoiceSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: ArrayBufferView | ArrayBuffer): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type VoiceTransportStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface VoiceTransport {
  /** Open the socket. Resolves on the first successful connect. */
  connect(): Promise<void>;
  send(frame: VoiceClientFrame, payload?: Uint8Array): void;
  /** Server frames, already parsed against the contract. */
  on(listener: (frame: VoiceServerFrame, payload: Uint8Array) => void): () => void;
  onStatus(listener: (status: VoiceTransportStatus) => void): () => void;
  readonly status: VoiceTransportStatus;
  /** Close for good — no reconnect. */
  close(): void;
}

export interface VoiceSocketTransportOptions {
  url: string;
  createSocket?: (url: string) => VoiceSocketLike;
  /** Backoff schedule; the last entry repeats. Set `[]` to disable reconnect. */
  reconnectDelaysMs?: number[];
  schedule?: (fn: () => void, ms: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
}

const DEFAULT_BACKOFF_MS = [250, 500, 1000, 2000, 5000];

/** Build the lane URL for the current page (ws:// or wss:// to match the page). */
export function voiceSocketUrl(location: { protocol: string; host: string }): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}${VOICE_SOCKET_PATH}`;
}

export function createVoiceSocketTransport(opts: VoiceSocketTransportOptions): VoiceTransport {
  const backoff = opts.reconnectDelaysMs ?? DEFAULT_BACKOFF_MS;
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = opts.cancelSchedule ?? ((handle) => clearTimeout(handle as never));
  const createSocket =
    opts.createSocket ?? ((url: string) => new WebSocket(url) as unknown as VoiceSocketLike);

  const frameListeners = new Set<(frame: VoiceServerFrame, payload: Uint8Array) => void>();
  const statusListeners = new Set<(status: VoiceTransportStatus) => void>();

  let socket: VoiceSocketLike | null = null;
  let status: VoiceTransportStatus = 'closed';
  let attempt = 0;
  let retryHandle: unknown = null;
  let disposed = false;

  const setStatus = (next: VoiceTransportStatus): void => {
    if (status === next) return;
    status = next;
    for (const listener of [...statusListeners]) listener(next);
  };

  const open = (onFirstOpen?: () => void, onFirstFail?: (err: Error) => void): void => {
    const ws = createSocket(opts.url);
    ws.binaryType = 'arraybuffer';
    socket = ws;
    let settled = false;

    ws.onopen = () => {
      attempt = 0;
      setStatus('open');
      if (!settled) {
        settled = true;
        onFirstOpen?.();
      }
    };

    ws.onmessage = (event) => {
      const bytes = toBytes(event.data);
      if (!bytes) return;
      const decoded = decodeVoiceServerFrame(bytes);
      // An unrecognized frame is ignored, never cast — the socket carries
      // untrusted bytes like any other network input.
      if (!decoded) return;
      for (const listener of [...frameListeners]) listener(decoded.header, decoded.payload);
    };

    ws.onerror = () => {
      if (!settled) {
        settled = true;
        onFirstFail?.(new Error('Could not open the voice link.'));
      }
    };

    ws.onclose = () => {
      if (socket === ws) socket = null;
      if (disposed) {
        setStatus('closed');
        return;
      }
      if (!settled) {
        settled = true;
        onFirstFail?.(new Error('Could not open the voice link.'));
        return;
      }
      reconnect();
    };
  };

  const reconnect = (): void => {
    if (disposed || backoff.length === 0) {
      setStatus('closed');
      return;
    }
    setStatus('reconnecting');
    const delay = backoff[Math.min(attempt, backoff.length - 1)] ?? 1000;
    attempt += 1;
    retryHandle = schedule(() => {
      retryHandle = null;
      if (disposed) return;
      open();
    }, delay);
  };

  return {
    connect(): Promise<void> {
      disposed = false;
      setStatus('connecting');
      return new Promise<void>((resolve, reject) => {
        open(resolve, reject);
      });
    },

    send(frame: VoiceClientFrame, payload?: Uint8Array): void {
      const ws = socket;
      // Dropping a frame while the link is down is deliberate: a mid-drop
      // utterance is discarded, not queued for replay into a fresh session.
      if (!ws || status !== 'open') return;
      ws.send(encodeVoiceFrame(frame, payload));
    },

    on(listener): () => void {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    },

    onStatus(listener): () => void {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },

    get status(): VoiceTransportStatus {
      return status;
    },

    close(): void {
      disposed = true;
      if (retryHandle !== null) {
        cancel(retryHandle);
        retryHandle = null;
      }
      const ws = socket;
      socket = null;
      ws?.close();
      setStatus('closed');
    },
  };
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  return null;
}
