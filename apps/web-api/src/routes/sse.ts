import type { SseEvent } from '@ethosagent/web-contracts';
import { Hono } from 'hono';
// Side-effect import: augments Hono's `ContextVariableMap` with `requestId`.
import 'hono/request-id';
import { streamSSE } from 'hono/streaming';
import type { ChatService } from '../features/chat/service';

// SSE stream for `/sse/sessions/:id`. Delegates to `ChatService.subscribe`,
// which:
//   • replays buffered events with `seq > Last-Event-ID` (post-disconnect resume)
//   • registers a live listener for new events
//
// Each frame carries:
//   id:    the buffer seq (monotonic per session)
//   data:  JSON-serialised SseEvent
//
// The browser's native EventSource auto-reconnects with `Last-Event-ID:
// <last-seen-seq>` on drop, so resume is transparent — no client reconnect
// code needed (this is the praxis-stack pivot's whole point: SSE replaces
// the WS keepalive plumbing in the spec).

export interface SseRoutesOptions {
  chat: ChatService;
}

export function sseRoutes(opts: SseRoutesOptions) {
  const app = new Hono();

  app.get('/sessions/:id', async (c) => {
    const sessionId = c.req.param('id');
    const lastIdHeader = c.req.header('Last-Event-ID');
    const sinceSeq = parseLastEventId(lastIdHeader);
    const requestId: string | undefined = c.get('requestId');

    return streamSSE(c, async (stream) => {
      let unsubscribe: (() => void) | null = null;
      let aborted = false;

      stream.onAbort(() => {
        aborted = true;
        if (unsubscribe) unsubscribe();
      });

      // B1 — lead with the stream's own `x-request-id`. It is on the response
      // header too, but `EventSource` exposes no response headers to the
      // browser, so header-only would leave the web UI with no id to quote.
      // Deliberately NO `id:` line: this frame is per-connection, not a
      // buffered session event, so it must not move the client's
      // `Last-Event-ID` cursor or renumber the replay that follows.
      if (requestId) {
        const meta: SseEvent = { type: 'stream_meta', requestId };
        try {
          await stream.writeSSE({ data: JSON.stringify(meta) });
        } catch {
          // Client hung up before the first byte — the subscribe path below
          // handles teardown; nothing to do here.
        }
      }

      unsubscribe = opts.chat.subscribe(sessionId, sinceSeq, async (buffered) => {
        // Skip once the stream is aborted (tab-switch / disconnect). Writing to
        // an aborted stream can reject; a floated rejection here would otherwise
        // crash the process, so any write error marks us aborted and unsubscribes.
        //
        // No `event:` field on purpose. Setting it to a non-default name makes
        // the browser's `EventSource.onmessage` skip the frame — only matching
        // `addEventListener('<type>', ...)` would catch it. The client parses
        // the type out of the JSON `data` payload (every event has a
        // discriminator `type` field), so an explicit `event:` line is redundant
        // AND breaks the default handler. Curl users still see the type via
        // `data:` content.
        if (aborted) return;
        try {
          await stream.writeSSE({
            id: String(buffered.seq),
            data: JSON.stringify(buffered.event),
          });
        } catch {
          aborted = true;
          if (unsubscribe) unsubscribe();
        }
      });

      // Block forever — `onAbort` is the only way out.
      await new Promise<void>(() => {});
    });
  });

  return app;
}

function parseLastEventId(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}
