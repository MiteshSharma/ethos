import { type SseEvent, SseEventSchema } from '@ethosagent/web-contracts';

// Thin wrapper around the browser's native EventSource for the chat /
// approval / push-notification stream. Two responsibilities:
//
//   1. Parse every `data:` line through the shared Zod schema so handlers
//      see fully-typed `SseEvent`s — drift between server and client
//      surfaces here as a runtime parse error rather than silent type
//      confusion.
//
//   2. Surface the `id:` line (the buffer seq) so callers can resume
//      cleanly. The browser already echoes the last seen id on reconnect
//      via `Last-Event-ID`; the app rarely needs to read it directly, but
//      tests + multi-tab debugging do.
//
// The browser handles reconnect-on-drop natively. We intentionally do NOT
// add a custom keepalive layer (the praxis-stack pivot deleted that work
// for SSE; see plan/phases/26-web-ui.md "Findings deleted by stack pivot").

export interface SseSubscriberOptions {
  /** Override the URL base. Defaults to same-origin. */
  apiBase?: string;
  /** Resume cursor — server replays everything with `seq > sinceSeq`. */
  sinceSeq?: number;
  /** Called for every event the server sends. Errors thrown here propagate
   *  to `onError`. */
  onEvent: (event: SseEvent, seq: number) => void;
  /** Connection-level errors (parse failures, dropped sockets). The
   *  EventSource will keep trying to reconnect even after these — return
   *  `'close'` from this handler to abort. Returning anything else (or
   *  nothing) keeps the stream open. */
  onError?: (err: unknown) => 'close' | undefined;
}

export interface SseSubscription {
  close(): void;
  /** Last seq the client observed. Useful for debugging mid-flight resume. */
  readonly lastSeq: number;
}

/**
 * Open the SSE stream for a session. Returns immediately with a handle the
 * caller `close()`s when their UI unmounts.
 */
export function subscribeToSession(sessionId: string, opts: SseSubscriberOptions): SseSubscription {
  const base = opts.apiBase ?? import.meta.env.VITE_API_URL ?? '';
  const url = new URL(`${base}/sse/sessions/${sessionId}`, window.location.origin);
  if (opts.sinceSeq && opts.sinceSeq > 0) {
    // EventSource doesn't let us set request headers, so encode the resume
    // hint as a query param. The server reads `Last-Event-ID` for
    // browser-driven reconnects; this is the explicit-resume escape
    // hatch (e.g. tests, "rewind" UI later).
    url.searchParams.set('lastEventId', String(opts.sinceSeq));
  }

  const source = new EventSource(url.toString(), { withCredentials: true });
  const state = { lastSeq: opts.sinceSeq ?? 0 };

  source.onmessage = (raw) => {
    const seq = raw.lastEventId ? Number(raw.lastEventId) : state.lastSeq + 1;
    let parsed: SseEvent;
    try {
      const json = JSON.parse(raw.data) as unknown;
      parsed = SseEventSchema.parse(json);
    } catch (err) {
      // A bad event is surfaced but the stream stays open — the browser's
      // auto-reconnect would re-fire on drop, but a one-off parse error
      // shouldn't tear down a working subscription.
      if (opts.onError?.(err) === 'close') source.close();
      return;
    }
    state.lastSeq = seq;
    opts.onEvent(parsed, seq);
  };

  source.onerror = (err) => {
    if (opts.onError?.(err) === 'close') source.close();
  };

  return {
    close: () => source.close(),
    get lastSeq() {
      return state.lastSeq;
    },
  };
}
