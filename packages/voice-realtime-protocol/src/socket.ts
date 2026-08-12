// The one transport seam every realtime session sits on — TYPES ONLY.
//
// OpenAI Realtime and Gemini Live both speak a JSON-event protocol over a
// single WebSocket; only the URL, the credential placement and the message
// vocabulary differ. This module describes the socket and owns no
// implementation of it: the server side supplies a `ws` client
// (`createWsRealtimeSocket` in `@ethosagent/voice-providers`), the browser
// supplies a native `WebSocket` (`createBrowserRealtimeSocket` in
// `apps/web/src/features/voice/`), and tests supply an in-memory fake
// (`createFakeRealtimeServer`).
//
// Nothing here reconnects, backs off, or heartbeats. A dropped realtime session
// surfaces as a `closed` event on `RealtimeSession.events` and the caller
// decides whether to dial again; a transport that silently redialled would
// resurrect a session whose conversational state the model no longer holds.

export interface RealtimeSocketInit {
  url: string;
  /**
   * Request headers. The `ws` client supports these; a browser `WebSocket`
   * does NOT — which is exactly why the browser-direct path carries its
   * credential in a subprotocol instead.
   */
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
