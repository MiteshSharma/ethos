import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteObservabilityStore } from '../store';

function tmpDb(): string {
  return join(tmpdir(), `obs-activity-${randomUUID()}.db`);
}

// `getRecentActivity` merges spans, turn traces and events into one timeline.
// The fixture below gives each personality one turn, one tool call and one
// event, at known timestamps, so ordering and scoping are both checkable.

describe('SQLiteObservabilityStore.getRecentActivity', () => {
  let store: SQLiteObservabilityStore;
  const traceA = 'trace-a';
  const traceB = 'trace-b';

  beforeEach(() => {
    store = new SQLiteObservabilityStore(tmpDb());

    store.insertTrace({
      traceId: traceA,
      sessionId: 'sess-a',
      kind: 'turn',
      startTs: 1000,
      subjectId: 'agent-a',
    });
    store.insertTrace({
      traceId: traceB,
      sessionId: 'sess-b',
      kind: 'turn',
      startTs: 2000,
      subjectId: 'agent-b',
    });

    store.insertSpan({
      spanId: 'span-a',
      traceId: traceA,
      kind: 'tool_call',
      name: 'read_file',
      startTs: 1100,
      attrs: { path: '/tmp/x' },
    });
    store.insertSpan({
      spanId: 'span-b',
      traceId: traceB,
      kind: 'tool_call',
      name: 'bash',
      startTs: 2100,
    });
    store.insertSpan({
      spanId: 'span-llm-a',
      traceId: traceA,
      kind: 'llm_call',
      name: 'claude-test',
      startTs: 1200,
    });
    // A `hook` span is neither a tool nor a model call — it must not show up.
    store.insertSpan({
      spanId: 'span-hook-a',
      traceId: traceA,
      kind: 'hook',
      name: 'before_tool_call',
      startTs: 1300,
    });

    store.insertEvent({
      eventId: 'ev-a',
      traceId: traceA,
      ts: 1400,
      category: 'safety.block',
      severity: 'warn',
      details: { rule: 'no-rm' },
    });
    store.insertEvent({
      eventId: 'ev-b',
      traceId: traceB,
      ts: 2400,
      category: 'memory.write',
      severity: 'info',
    });
    // No trace — attributable to nobody, so global-only.
    store.insertEvent({
      eventId: 'ev-orphan',
      ts: 3000,
      category: 'app.login',
      severity: 'info',
    });
  });

  afterEach(() => store.close());

  it('returns every subject newest-first when no personality is given', () => {
    const rows = store.getRecentActivity({ limit: 50 });
    expect(rows.map((r) => r.id)).toEqual([
      'ev-orphan',
      'ev-b',
      'span-b',
      traceB,
      'ev-a',
      'span-llm-a',
      'span-a',
      traceA,
    ]);
    expect(rows.map((r) => r.startedAt)).toEqual([3000, 2400, 2100, 2000, 1400, 1200, 1100, 1000]);
  });

  it('scopes to one personality when personalityId is given', () => {
    const rows = store.getRecentActivity({ personalityId: 'agent-a', limit: 50 });
    expect(rows.map((r) => r.id)).toEqual(['ev-a', 'span-llm-a', 'span-a', traceA]);
    expect(rows.every((r) => r.personalityId === 'agent-a')).toBe(true);
    expect(rows.every((r) => r.sessionId === 'sess-a')).toBe(true);
  });

  it('carries kind, name, status, endedAt and parsed details', () => {
    store.closeSpan('span-a', 'ok', { durationMs: 12 });
    store.closeTrace(traceA, 'error');

    const rows = store.getRecentActivity({ personalityId: 'agent-a', limit: 50 });
    const byId = new Map(rows.map((r) => [r.id, r]));

    const tool = byId.get('span-a');
    expect(tool?.kind).toBe('tool_call');
    expect(tool?.name).toBe('read_file');
    expect(tool?.status).toBe('ok');
    expect(tool?.endedAt).toBeGreaterThan(0);
    expect(tool?.details).toMatchObject({ path: '/tmp/x', durationMs: 12 });

    const turn = byId.get(traceA);
    expect(turn?.kind).toBe('turn');
    expect(turn?.name).toBe('turn');
    expect(turn?.status).toBe('error');

    const event = byId.get('ev-a');
    expect(event?.kind).toBe('event');
    expect(event?.name).toBe('safety.block');
    // Events have no duration; severity stands in for status.
    expect(event?.status).toBe('warn');
    expect(event?.endedAt).toBeNull();
    expect(event?.details).toEqual({ rule: 'no-rm' });

    expect(byId.get('span-llm-a')?.kind).toBe('llm_call');
  });

  it('leaves an untraced event out of a scoped view but keeps it globally', () => {
    const orphan = store.getRecentActivity({ limit: 50 }).find((r) => r.id === 'ev-orphan');
    expect(orphan?.personalityId).toBeNull();
    expect(orphan?.sessionId).toBeNull();

    const scoped = store.getRecentActivity({ personalityId: 'agent-a', limit: 50 });
    expect(scoped.find((r) => r.id === 'ev-orphan')).toBeUndefined();
  });

  it('caps at limit and paginates with an exclusive before cursor', () => {
    const first = store.getRecentActivity({ limit: 3 });
    expect(first.map((r) => r.id)).toEqual(['ev-orphan', 'ev-b', 'span-b']);

    const oldest = first.at(-1)?.startedAt ?? 0;
    const second = store.getRecentActivity({ before: oldest, limit: 3 });
    expect(second.map((r) => r.id)).toEqual([traceB, 'ev-a', 'span-llm-a']);

    const third = store.getRecentActivity({
      before: second.at(-1)?.startedAt ?? 0,
      limit: 3,
    });
    expect(third.map((r) => r.id)).toEqual(['span-a', traceA]);
  });

  it('combines the personality filter and the cursor', () => {
    const rows = store.getRecentActivity({ personalityId: 'agent-b', before: 2400, limit: 10 });
    expect(rows.map((r) => r.id)).toEqual(['span-b', traceB]);
  });

  it('returns an empty page for an unknown personality', () => {
    expect(store.getRecentActivity({ personalityId: 'nobody', limit: 10 })).toEqual([]);
  });
});

// Millisecond-precision `start_ts` plus `ToolRegistry.executeParallel` means a
// batch of tool calls routinely shares ONE timestamp. Ordering on the timestamp
// alone is non-deterministic, and a page boundary landing inside such a batch
// silently drops the rest of it from "load older" — the same bug class the repo
// already fixed in `getMessages` with rowid tie-breaking.
describe('SQLiteObservabilityStore.getRecentActivity — same-millisecond paging', () => {
  let store: SQLiteObservabilityStore;
  const SHARED_TS = 5000;

  beforeEach(() => {
    store = new SQLiteObservabilityStore(tmpDb());
    store.insertTrace({
      traceId: 'trace-p',
      sessionId: 'sess-p',
      kind: 'turn',
      startTs: SHARED_TS,
      subjectId: 'agent-p',
    });
    // Seven parallel tool calls, all opened in the same millisecond as the turn.
    for (let i = 0; i < 7; i++) {
      store.insertSpan({
        spanId: `span-${i}`,
        traceId: 'trace-p',
        kind: 'tool_call',
        name: `tool_${i}`,
        startTs: SHARED_TS,
      });
    }
  });

  afterEach(() => store.close());

  it('orders a tied group deterministically by id', () => {
    const once = store.getRecentActivity({ limit: 50 }).map((r) => r.id);
    const twice = store.getRecentActivity({ limit: 50 }).map((r) => r.id);
    expect(once).toEqual(twice);
    // `id DESC` within the tie: 'trace-p' > 'span-6' > … > 'span-0'.
    expect(once).toEqual([
      'trace-p',
      'span-6',
      'span-5',
      'span-4',
      'span-3',
      'span-2',
      'span-1',
      'span-0',
    ]);
  });

  it('pages through a tied group exactly once — no duplicates, no skips', () => {
    const seen: string[] = [];
    let before: number | undefined;
    let beforeId: string | undefined;

    for (let page = 0; page < 10; page++) {
      const rows = store.getRecentActivity({
        limit: 3,
        ...(before === undefined ? {} : { before }),
        ...(beforeId === undefined ? {} : { beforeId }),
      });
      seen.push(...rows.map((r) => r.id));
      const oldest = rows.at(-1);
      if (rows.length < 3 || !oldest) break;
      before = oldest.startedAt;
      beforeId = oldest.id;
    }

    expect(seen).toEqual([
      'trace-p',
      'span-6',
      'span-5',
      'span-4',
      'span-3',
      'span-2',
      'span-1',
      'span-0',
    ]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('scopes and pages a tied group together', () => {
    const first = store.getRecentActivity({ personalityId: 'agent-p', limit: 4 });
    expect(first.map((r) => r.id)).toEqual(['trace-p', 'span-6', 'span-5', 'span-4']);

    const oldest = first.at(-1);
    const second = store.getRecentActivity({
      personalityId: 'agent-p',
      limit: 4,
      before: oldest?.startedAt ?? 0,
      beforeId: oldest?.id ?? '',
    });
    expect(second.map((r) => r.id)).toEqual(['span-3', 'span-2', 'span-1', 'span-0']);
  });
});
