import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KanbanStore } from '@ethosagent/kanban-store';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kanbanSseRoutes } from '../../routes/kanban-sse';
import { KanbanService } from '../../services/kanban.service';

// Route-level test for `/sse/kanban/:team`, modeled on
// `apps/web-api/src/__tests__/routes/sse.test.ts` — reads the SSE response
// body as a stream of frames. A bare Hono app mounting `kanbanSseRoutes`
// directly (no full `createWebApi`/auth harness — auth on `/sse/*` is applied
// in `routes/index.ts`, outside this route module, same as `goal-sse.ts`).
// The service points at a temp `teamsDir` so nothing touches a real
// `~/.ethos/teams`.

describe('SSE — /sse/kanban/:team', () => {
  let dir: string;
  let service: KanbanService;
  let app: Hono;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kanban-sse-'));
    service = new KanbanService({ teamsDir: dir });
    app = new Hono();
    app.route('/sse', kanbanSseRoutes({ kanban: service }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeManifest(name: string, content: string): void {
    writeFileSync(join(dir, `${name}.yaml`), content);
  }

  function openBoard(name: string): KanbanStore {
    mkdirSync(join(dir, name), { recursive: true });
    return new KanbanStore(join(dir, name, 'board.db'));
  }

  it('replays stored task_events on connect', async () => {
    writeManifest(
      'analytics',
      `
name: analytics
description: x
domain_capabilities: [x]
members:
  - personality: alpha
`,
    );
    const store = openBoard('analytics');
    const task = store.createTask({ title: 'first' });
    store.updateStatus(task.id, 'running', undefined, 'alpha');
    store.close();

    const res = await app.request('/sse/kanban/analytics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/i);

    const frames = await readSseFrames(res, 300);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames.some((f) => f.event.kind === 'created')).toBe(true);
    expect(frames.some((f) => f.event.kind === 'status_changed')).toBe(true);
    // ids are monotonic
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]?.id).toBeGreaterThan(frames[i - 1]?.id ?? 0);
    }
  });

  it('a cold connect (no Last-Event-ID) replays a bounded recent tail, not the whole table', async () => {
    writeManifest(
      'analytics',
      `
name: analytics
description: x
domain_capabilities: [x]
members:
  - personality: alpha
`,
    );
    const store = openBoard('analytics');
    // Each task creation writes a `created` event; 120 tasks comfortably
    // exceeds the service's RECENT_EVENTS_CAP (100) so an unbounded replay
    // would return more frames than the cap allows.
    const taskCount = 120;
    for (let i = 0; i < taskCount; i++) {
      store.createTask({ title: `task ${i}` });
    }
    store.close();

    const res = await app.request('/sse/kanban/analytics');
    const frames = await readSseFrames(res, 500);

    expect(frames.length).toBeLessThan(taskCount);
    expect(frames.length).toBeLessThanOrEqual(100);
    // The tail is still the MOST RECENT events, in ascending id order.
    expect(frames[frames.length - 1]?.event.taskId).toBeDefined();
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]?.id).toBeGreaterThan(frames[i - 1]?.id ?? 0);
    }
  });

  it('Last-Event-ID resume skips events at or before the given id', async () => {
    writeManifest(
      'analytics',
      `
name: analytics
description: x
domain_capabilities: [x]
members:
  - personality: alpha
`,
    );
    const store = openBoard('analytics');
    const task = store.createTask({ title: 'first' });
    store.updateStatus(task.id, 'running', undefined, 'alpha');
    store.close();

    const initial = await app.request('/sse/kanban/analytics');
    const allFrames = await readSseFrames(initial, 300);
    expect(allFrames.length).toBeGreaterThanOrEqual(2);

    const firstId = allFrames[0]?.id ?? 0;
    const reconnect = await app.request('/sse/kanban/analytics', {
      headers: { 'last-event-id': String(firstId) },
    });
    const replayFrames = await readSseFrames(reconnect, 300);

    expect(replayFrames.length).toBe(allFrames.length - 1);
    expect(replayFrames[0]?.id).toBe(allFrames[1]?.id);
  });

  it('delivers a new task_events row written after the connection opened', async () => {
    writeManifest(
      'analytics',
      `
name: analytics
description: x
domain_capabilities: [x]
members:
  - personality: alpha
`,
    );
    const store = openBoard('analytics');
    store.createTask({ title: 'first' });
    // Connection opens with everything already replayed; keep the store open
    // so a write DURING the stream's live-poll window is observed.
    const res = await app.request('/sse/kanban/analytics');
    const initialFrames = await readSseFrames(res, 200);
    expect(initialFrames.length).toBeGreaterThanOrEqual(1);

    // Live delivery requires a second connection since `app.request` above
    // already consumed/closed its stream. Open a fresh one at the last-seen
    // cursor, wait for its poll timer to be armed, then write a new event so
    // this specifically exercises the poll path (not the initial replay),
    // and read across the 1000ms poll tick.
    const lastId = initialFrames[initialFrames.length - 1]?.id ?? 0;
    const live = await app.request('/sse/kanban/analytics', {
      headers: { 'last-event-id': String(lastId) },
    });
    await sleep(50);

    const second = store.createTask({ title: 'second' });
    const frames = await readSseFrames(live, 1500);
    store.close();

    expect(frames.some((f) => f.event.taskId === second.id && f.event.kind === 'created')).toBe(
      true,
    );
  });
});

interface ParsedSseFrame {
  id: number;
  event: { kind?: string; taskId?: string; [k: string]: unknown };
}

// Reads frames for a fixed window rather than "until done" — a kanban board
// stream has no terminal state (unlike the goal/session streams), so the test
// just drains whatever arrives in `timeoutMs`.
async function readSseFrames(response: Response, timeoutMs: number): Promise<ParsedSseFrame[]> {
  if (!response.body) throw new Error('SSE response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const out: ParsedSseFrame[] = [];
  const start = Date.now();
  const timedOut = Symbol('timeout');

  // One outstanding `reader.read()` at a time — racing a FRESH `read()` call
  // against a timeout on every loop tick (as opposed to reusing the same
  // pending call while it's still unresolved) queues multiple concurrent read
  // requests. The reader fulfills those FIFO, so a chunk that arrives after
  // several timed-out ticks resolves an earlier, abandoned promise instead of
  // the one this loop is currently awaiting — the data is silently lost.
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

  try {
    while (Date.now() - start < timeoutMs) {
      if (!pending) pending = reader.read();
      const race = await Promise.race([
        pending,
        new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), 50)),
      ]);
      if (race === timedOut) continue;

      pending = null;
      const { value, done } = race;
      if (done) break;
      if (value) buf += decoder.decode(value, { stream: true });

      while (true) {
        const split = buf.indexOf('\n\n');
        if (split === -1) break;
        const frame = buf.slice(0, split);
        buf = buf.slice(split + 2);
        const parsed = parseFrame(frame);
        if (parsed) out.push(parsed);
      }
    }
  } finally {
    reader.releaseLock();
    void response.body.cancel().catch(() => {});
  }
  return out;
}

function parseFrame(frame: string): ParsedSseFrame | null {
  let id = 0;
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('id:')) id = Number(line.slice(3).trim()) || 0;
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  try {
    return { id, event: JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
