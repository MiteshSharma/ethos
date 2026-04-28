import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ChatService } from '../services/chat.service';

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

    return streamSSE(c, async (stream) => {
      let unsubscribe: (() => void) | null = null;

      stream.onAbort(() => {
        if (unsubscribe) unsubscribe();
      });

      unsubscribe = opts.chat.subscribe(sessionId, sinceSeq, async (buffered) => {
        // Stream is closed once `onAbort` fires; writes after that no-op safely
        // because `streamSSE` guards them.
        //
        // No `event:` field on purpose. Setting it to a non-default name makes
        // the browser's `EventSource.onmessage` skip the frame — only matching
        // `addEventListener('<type>', ...)` would catch it. The client parses
        // the type out of the JSON `data` payload (every event has a
        // discriminator `type` field), so an explicit `event:` line is redundant
        // AND breaks the default handler. Curl users still see the type via
        // `data:` content.
        await stream.writeSSE({
          id: String(buffered.seq),
          data: JSON.stringify(buffered.event),
        });
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
