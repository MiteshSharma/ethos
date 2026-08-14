// The `ws` implementation of the satellite transport seam.
//
// Same split, and the same reason, as `createWsRealtimeSocket` in
// `@ethosagent/voice-providers`: the client logic in `node-client.ts` carries
// no transport at all, so a test drives it with a fake and a host could drive
// it with anything that moves bytes. This file is the node half, and the only
// place in the satellite stack that imports `ws`.
//
// `ws` is pure JavaScript — importing it is safe on a headless box, which is
// why it is a top-level import here while every audio and ONNX binding in this
// package is behind a lazy `import()`.

import { WebSocket } from 'ws';
import type {
  SatelliteSocket,
  SatelliteSocketFactory,
  SatelliteSocketHandlers,
} from './node-client';

/** The production transport: one `ws` client socket per satellite connection. */
export const createWsSatelliteSocket: SatelliteSocketFactory = (
  url: string,
  init: { headers?: Record<string, string> },
  handlers: SatelliteSocketHandlers,
): SatelliteSocket => {
  const socket = new WebSocket(url, init.headers ? { headers: init.headers } : {});

  socket.on('open', () => handlers.onOpen());
  socket.on('message', (data: unknown, isBinary: boolean) => handlers.onMessage(data, isBinary));
  socket.on('error', (err: Error) => handlers.onError(err));
  socket.on('close', () => handlers.onClose());

  return {
    send: (data: Uint8Array) => socket.send(data),
    close: () => socket.close(),
  };
};
