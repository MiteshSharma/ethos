import type {
  RealtimeSocket,
  RealtimeSocketHandlers,
  RealtimeSocketInit,
} from '@ethosagent/voice-realtime-protocol';

// The browser half of the realtime transport seam — a native `WebSocket`.
//
// The node half is `createWsRealtimeSocket` in `@ethosagent/voice-providers`.
// Two implementations of one seam is the whole reason the frame mapping could
// move into a package both sides import: this file is small precisely because
// nothing about the PROTOCOL lives in it.
//
// `init.headers` is ignored, and cannot be otherwise: a browser `WebSocket`
// has no header API. That is why the browser-direct credential rides the
// subprotocol list instead (see `openaiRealtimeBrowserSubprotocols`).

export function createBrowserRealtimeSocket(
  init: RealtimeSocketInit,
  handlers: RealtimeSocketHandlers,
): RealtimeSocket {
  const socket = init.subprotocols?.length
    ? new WebSocket(init.url, init.subprotocols)
    : new WebSocket(init.url);

  socket.addEventListener('open', () => handlers.onOpen());
  socket.addEventListener('message', (event: MessageEvent) => {
    // Binary frames are dropped: neither provider sends them, and a silently
    // stringified ArrayBuffer would surface as an unparseable-JSON error.
    if (typeof event.data === 'string') handlers.onMessage(event.data);
  });
  // A browser `error` event carries no detail by design (cross-origin leak
  // protection). The close event that follows is where the reason lives.
  socket.addEventListener('error', () => handlers.onError('realtime socket error'));
  socket.addEventListener('close', (event: CloseEvent) => {
    handlers.onClose(event.reason || `socket closed (code ${event.code})`);
  });

  return {
    send: (data: string) => socket.send(data),
    close: (code?: number, reason?: string) => socket.close(code ?? 1000, reason),
  };
}
