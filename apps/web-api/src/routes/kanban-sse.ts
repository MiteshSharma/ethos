import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { KanbanService } from '../services/kanban.service';

export interface KanbanSseOptions {
  kanban: KanbanService;
}

// SSE stream for `/sse/kanban/:team`. Replays `task_events` since
// `Last-Event-ID`, then polls for new rows every 1000ms (matching the team
// dispatcher's own poll cadence, `DEFAULT_POLL_MS`,
// `extensions/team-supervisor/src/dispatcher.ts:133`) and writes each as an
// SSE frame with `id: String(event.id)`. Unlike `goal-sse.ts`, a board has no
// terminal/"done" state — the stream just runs until the client disconnects,
// same as `sse.ts`'s session stream.

export function kanbanSseRoutes(opts: KanbanSseOptions) {
  const app = new Hono();

  app.get('/kanban/:team', async (c) => {
    const team = c.req.param('team');
    const lastIdHeader = c.req.header('Last-Event-ID');
    const sinceId = parseLastEventId(lastIdHeader);

    return streamSSE(c, async (stream) => {
      let lastId = sinceId;
      let pollTimer: ReturnType<typeof setInterval> | null = null;

      stream.onAbort(() => {
        if (pollTimer) clearInterval(pollTimer);
      });

      // Replay stored events (respecting Last-Event-ID for reconnect)
      const stored = await opts.kanban.getEventsSince(team, lastId);
      for (const event of stored) {
        await stream.writeSSE({
          id: String(event.id),
          data: JSON.stringify(event),
        });
        lastId = event.id;
      }

      // Poll for new events. No terminal state to watch for — the board
      // stream runs until the client disconnects (onAbort cleans up).
      pollTimer = setInterval(() => {
        void (async () => {
          const newEvents = await opts.kanban.getEventsSince(team, lastId);
          for (const event of newEvents) {
            await stream.writeSSE({
              id: String(event.id),
              data: JSON.stringify(event),
            });
            lastId = event.id;
          }
        })();
      }, 1000);

      // Block until client disconnects (onAbort cleans up).
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
