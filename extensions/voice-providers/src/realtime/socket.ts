// The one transport seam every realtime provider sits on.
//
// OpenAI Realtime and Gemini Live both speak a JSON-event protocol over a
// single WebSocket; only the URL, the credential placement and the message
// vocabulary differ. This module owns the socket and nothing else — no
// reconnect, no backoff, no heartbeat. A dropped realtime session surfaces as a
// `closed` event on `RealtimeSession.events` and the caller decides whether to
// dial again; a transport that silently redialled would resurrect a session
// whose conversational state the model no longer holds.
//
// The factory type is the injection point: tests drive both providers against
// an in-memory fake with no network and no credentials (see
// `createFakeRealtimeServer` in `../realtime-conformance`).

import { WebSocket } from 'ws';

export interface RealtimeSocketInit {
  url: string;
  /** Request headers. The `ws` client supports these; a browser WebSocket does not. */
  headers?: Record<string, string>;
  subprotocols?: string[];
}

export interface RealtimeSocketHandlers {
  onOpen(): void;
  /** One decoded text frame. Binary frames are dropped — no provider here sends them. */
  onMessage(data: string): void;
  onError(message: string): void;
  onClose(reason: string): void;
}

export interface RealtimeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type RealtimeSocketFactory = (
  init: RealtimeSocketInit,
  handlers: RealtimeSocketHandlers,
) => RealtimeSocket;

/** `ws` delivers a text frame as a Buffer, an ArrayBuffer, or a Buffer list. */
function frameToString(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf-8');
  if (Buffer.isBuffer(data)) return data.toString('utf-8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf-8');
  return String(data);
}

/** The production transport: one `ws` client socket. */
export function createWsRealtimeSocket(
  init: RealtimeSocketInit,
  handlers: RealtimeSocketHandlers,
): RealtimeSocket {
  const socket = new WebSocket(init.url, init.subprotocols ?? [], {
    ...(init.headers ? { headers: init.headers } : {}),
  });

  socket.on('open', () => handlers.onOpen());
  socket.on('message', (data: unknown, isBinary: boolean) => {
    if (isBinary) return;
    handlers.onMessage(frameToString(data));
  });
  socket.on('error', (err: Error) => handlers.onError(err.message));
  socket.on('close', (code: number, reason: Buffer) => {
    const text = reason.length > 0 ? reason.toString('utf-8') : '';
    handlers.onClose(text || `socket closed (code ${code})`);
  });

  return {
    send: (data: string) => socket.send(data),
    close: (code?: number, reason?: string) => socket.close(code ?? 1000, reason),
  };
}
