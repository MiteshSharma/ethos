// The `ws` implementation of the realtime transport seam.
//
// The seam ITSELF (`RealtimeSocket*`) lives in
// `@ethosagent/voice-realtime-protocol`, which carries no transport at all, so
// the browser can implement the same seam with a native `WebSocket` and reuse
// every line of the frame mapping. This file is the node half and the only
// place in the realtime stack that imports `ws`.

import type {
  RealtimeSocket,
  RealtimeSocketHandlers,
  RealtimeSocketInit,
} from '@ethosagent/voice-realtime-protocol';
import { WebSocket } from 'ws';

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
