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
        await stream.writeSSE({
          id: String(buffered.seq),
          data: JSON.stringify(buffered.event),
          event: buffered.event.type,
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
