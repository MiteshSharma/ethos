import {
  type ActivityEvent,
  ActivityEventSchema,
  type SseEvent,
  SseEventSchema,
} from '@ethosagent/web-contracts';

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
//
// Connection sharing: a single chat page has several independent consumers
// (useChat, useDrawerStream, usePushEventToasts, StatusBar, Activity) that
// each subscribe to the same session. Opening one EventSource per call
// would exhaust the browser's ~6-per-origin HTTP/1.1 connection pool and
// stall every REST/RPC fetch behind the duplicates. So all subscribers for
// a given session share ONE underlying EventSource, fanned out in-process
// and reference-counted.
//
// Two stream families use that same machinery: `/sse/sessions/:id` (one
// session's events, bare `SseEvent` frames) and `/sse/activity` (every
// session's events on one connection, `ActivityEvent` envelopes). They
// differ only in URL, payload schema and registry key, so the pooling lives in
// `subscribeShared` below and each family is a thin wrapper over it.

export interface StreamSubscriberOptions<T> {
  /** Override the URL base. Defaults to same-origin. */
  apiBase?: string;
  /** Resume cursor — server replays everything with `seq > sinceSeq`. */
  sinceSeq?: number;
  /** Called for every event the server sends. Errors thrown here propagate
   *  to `onError`. */
  onEvent: (event: T, seq: number) => void;
  /** Connection-level errors (parse failures, dropped sockets). The
   *  EventSource will keep trying to reconnect even after these — return
   *  `'close'` from this handler to abort. Returning anything else (or
   *  nothing) keeps the stream open. */
  onError?: (err: unknown) => 'close' | undefined;
}

export type SseSubscriberOptions = StreamSubscriberOptions<SseEvent>;
export type ActivitySubscriberOptions = StreamSubscriberOptions<ActivityEvent>;

export interface SseSubscription {
  close(): void;
  /** Last seq the client observed. Useful for debugging mid-flight resume. */
  readonly lastSeq: number;
}

interface Subscriber<T> {
  onEvent: (event: T, seq: number) => void;
  onError?: (err: unknown) => 'close' | undefined;
}

interface SharedConnection<T> {
  source: EventSource;
  subscribers: Set<Subscriber<T>>;
  lastSeq: number;
}

// Keyed by `${base}|${sessionId}` / `${base}|activity|${scope}` so a
// differing apiBase doesn't collide (in practice all callers use the
// default). One registry per stream family keeps the payload types honest
// without a cast. Module-local state is fine — this file only ever runs in
// a single React app instance.
const sessionConnections = new Map<string, SharedConnection<SseEvent>>();
const activityConnections = new Map<string, SharedConnection<ActivityEvent>>();

/**
 * Open the SSE stream for a session. Returns immediately with a handle the
 * caller `close()`s when their UI unmounts.
 *
 * All subscribers for the same session share one EventSource. The first
 * subscriber opens it (using its `sinceSeq` for the `lastEventId` query
 * param); later subscribers attach to the live connection and receive
 * events from the current point forward — they do NOT get a replay of
 * events emitted before they joined. That's acceptable here because every
 * caller is a live consumer, not a resume-from-cursor reader.
 */
export function subscribeToSession(sessionId: string, opts: SseSubscriberOptions): SseSubscription {
  const base = opts.apiBase ?? import.meta.env.VITE_API_URL ?? '';
  return subscribeShared(
    sessionConnections,
    `${base}|${sessionId}`,
    () => new URL(`${base}/sse/sessions/${sessionId}`, window.location.origin),
    (json) => SseEventSchema.parse(json),
    opts,
  );
}

/**
 * Open the merged activity stream — every session's events on ONE
 * connection, optionally narrowed to a single agent.
 *
 * `personalityId === null` is the global feed (the `?personalityId=` param
 * is omitted entirely). Because scoping happens server-side, a per-agent
 * view costs the same single connection as the global one no matter how
 * many sessions that agent has, so nothing here fans out per session.
 *
 * Unlike `/sse/sessions/:id`, this stream sends no leading `stream_meta`
 * frame: every frame carries an `id:` and is a real `ActivityEvent`, and
 * the seq is the activity buffer's own counter, unrelated to any session's.
 */
export function subscribeToActivity(
  personalityId: string | null,
  opts: ActivitySubscriberOptions,
): SseSubscription {
  const base = opts.apiBase ?? import.meta.env.VITE_API_URL ?? '';
  return subscribeShared(
    activityConnections,
    `${base}|activity|${personalityId ?? 'global'}`,
    () => {
      const url = new URL(`${base}/sse/activity`, window.location.origin);
      if (personalityId) url.searchParams.set('personalityId', personalityId);
      return url;
    },
    (json) => ActivityEventSchema.parse(json),
    opts,
  );
}

function subscribeShared<T>(
  registry: Map<string, SharedConnection<T>>,
  key: string,
  buildUrl: () => URL,
  parse: (json: unknown) => T,
  opts: StreamSubscriberOptions<T>,
): SseSubscription {
  const subscriber: Subscriber<T> = { onEvent: opts.onEvent, onError: opts.onError };

  let conn = registry.get(key);
  if (!conn) {
    const url = buildUrl();
    if (opts.sinceSeq && opts.sinceSeq > 0) {
      // EventSource doesn't let us set request headers, so encode the
      // resume hint as a query param. The server reads `Last-Event-ID` for
      // browser-driven reconnects; this is the explicit-resume escape
      // hatch (e.g. a remount that already knows its cursor).
      url.searchParams.set('lastEventId', String(opts.sinceSeq));
    }

    const source = new EventSource(url.toString(), { withCredentials: true });
    const created: SharedConnection<T> = {
      source,
      subscribers: new Set([subscriber]),
      lastSeq: opts.sinceSeq ?? 0,
    };
    registry.set(key, created);
    conn = created;

    source.onmessage = (raw) => {
      const seq = raw.lastEventId ? Number(raw.lastEventId) : created.lastSeq + 1;
      let parsed: T;
      try {
        const json = JSON.parse(raw.data) as unknown;
        parsed = parse(json);
      } catch (err) {
        // A bad event is surfaced but the stream stays open — the browser's
        // auto-reconnect would re-fire on drop, but a one-off parse error
        // shouldn't tear down a working subscription. A subscriber asking to
        // `'close'` only detaches itself; the shared socket survives for the
        // others.
        for (const sub of [...created.subscribers]) {
          if (sub.onError?.(err) === 'close') created.subscribers.delete(sub);
        }
        closeIfEmpty(registry, key, created);
        return;
      }
      created.lastSeq = seq;
      for (const sub of [...created.subscribers]) {
        try {
          sub.onEvent(parsed, seq);
        } catch (err) {
          // One subscriber throwing must not break fan-out to the others.
          if (sub.onError?.(err) === 'close') created.subscribers.delete(sub);
        }
      }
      closeIfEmpty(registry, key, created);
    };

    source.onerror = (err) => {
      for (const sub of [...created.subscribers]) {
        if (sub.onError?.(err) === 'close') created.subscribers.delete(sub);
      }
      closeIfEmpty(registry, key, created);
    };
  } else {
    conn.subscribers.add(subscriber);
  }

  const shared = conn;
  return {
    close: () => {
      shared.subscribers.delete(subscriber);
      closeIfEmpty(registry, key, shared);
    },
    get lastSeq() {
      return shared.lastSeq;
    },
  };
}

/** Tear down the real EventSource once the last subscriber has left. A
 *  subsequent subscribe re-opens it. */
function closeIfEmpty<T>(
  registry: Map<string, SharedConnection<T>>,
  key: string,
  conn: SharedConnection<T>,
): void {
  if (conn.subscribers.size > 0) return;
  conn.source.close();
  // Only drop the entry if it's still the live one for this key — a
  // re-subscribe during teardown could already have replaced it.
  if (registry.get(key) === conn) registry.delete(key);
}
