// P2-counters (analytics-observability plan) — transactional, span-derived
// counters (D15), fixed histogram buckets (D18), and the v1 -> v2 migration
// that adds `metric_counters` (D2).

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import type { ObsEvent, Span } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FORBIDDEN_LABEL_KEYS, type MetricCounterRow } from '../metric-counters';
import { SQLiteObservabilityStore } from '../store';

let tmp: string;
let dbPath: string;
let store: SQLiteObservabilityStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obs-metrics-'));
  dbPath = join(tmp, 'observability.db');
  store = new SQLiteObservabilityStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

function counterFor(rows: MetricCounterRow[], metric: string, labels: Record<string, string>) {
  return rows.find(
    (r) => r.metric === metric && JSON.stringify(r.labels) === JSON.stringify(sortKeys(labels)),
  );
}

function sortKeys(labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(labels).sort()) out[k] = labels[k];
  return out;
}

function openLlmCallSpan(traceId: string, model: string): string {
  const spanId = randomUUID();
  const span: Span = { spanId, traceId, kind: 'llm_call', name: model, startTs: Date.now() };
  store.insertSpan(span);
  return spanId;
}

describe('migration: v1 -> v2 adds metric_counters', () => {
  it('creates the table when opening a legacy v1 DB', () => {
    const legacyPath = join(tmp, 'legacy.db');
    const seed = new Database(legacyPath);
    seed.exec(`
      CREATE TABLE traces (
        trace_id TEXT PRIMARY KEY, session_id TEXT, kind TEXT NOT NULL,
        start_ts INTEGER NOT NULL, end_ts INTEGER, status TEXT,
        subject_id TEXT, snapshot_id TEXT, attrs TEXT
      ) STRICT;
    `);
    seed.pragma('user_version = 1');
    seed.close();

    const opened = new SQLiteObservabilityStore(legacyPath);
    expect(opened.getMetricCounters()).toEqual([]);
    opened.close();

    const verify = new Database(legacyPath);
    const version = (verify.pragma('user_version') as Array<{ user_version: number }>)[0]
      ?.user_version;
    expect(version).toBe(3);
    verify.close();
  });

  it('is idempotent — re-opening after migration is a no-op', () => {
    const path = join(tmp, 'idempotent.db');
    const a = new SQLiteObservabilityStore(path);
    a.close();
    expect(() => {
      const b = new SQLiteObservabilityStore(path);
      b.close();
    }).not.toThrow();
  });
});

describe('closeSpan(llm_call) — counters', () => {
  it('increments tokens, cost, and duration histogram, with personality from the trace', () => {
    const traceId = randomUUID();
    store.insertTrace({ traceId, kind: 'turn', startTs: Date.now(), subjectId: 'engineer' });
    const spanId = openLlmCallSpan(traceId, 'claude-sonnet-5');

    store.closeSpan(spanId, 'ok', {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0.01,
      provider: 'anthropic',
      costBasis: 'priced',
    });

    const rows = store.getMetricCounters();
    const labels = { personality: 'engineer', provider: 'anthropic', model: 'claude-sonnet-5' };

    expect(counterFor(rows, 'ethos_llm_tokens_total', { ...labels, kind: 'input' })?.value).toBe(
      100,
    );
    expect(counterFor(rows, 'ethos_llm_tokens_total', { ...labels, kind: 'output' })?.value).toBe(
      50,
    );
    // Zero-count kinds are not written — no cache activity on this call.
    expect(
      counterFor(rows, 'ethos_llm_tokens_total', { ...labels, kind: 'cache_read' }),
    ).toBeUndefined();
    expect(counterFor(rows, 'ethos_llm_cost_usd_total', labels)?.value).toBeCloseTo(0.01);
    expect(counterFor(rows, 'ethos_llm_unpriced_calls_total', {})).toBeUndefined();

    // Histogram: duration was computed from the span's own start_ts..close;
    // just assert the count/sum rows exist with the LLM-only label set (no
    // `personality`, per D19) and every fixed bucket <= 64 is present at least
    // once (the observation must land in every bucket >= 0 for a fast call).
    const histLabels = { provider: 'anthropic', model: 'claude-sonnet-5' };
    expect(counterFor(rows, 'ethos_llm_request_duration_seconds_count', histLabels)?.value).toBe(1);
    expect(
      counterFor(rows, 'ethos_llm_request_duration_seconds_bucket', { ...histLabels, le: '+Inf' })
        ?.value,
    ).toBe(1);
  });

  it('reports ethos_llm_unpriced_calls_total only when costBasis is unknown', () => {
    const traceId = randomUUID();
    store.insertTrace({ traceId, kind: 'turn', startTs: Date.now(), subjectId: 'engineer' });
    const spanId = openLlmCallSpan(traceId, 'some-unknown-model');

    store.closeSpan(spanId, 'ok', {
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostUsd: 0,
      provider: 'openrouter',
      costBasis: 'unknown',
    });

    const rows = store.getMetricCounters();
    expect(
      counterFor(rows, 'ethos_llm_unpriced_calls_total', {
        provider: 'openrouter',
        model: 'some-unknown-model',
      })?.value,
    ).toBe(1);
  });

  it('accumulates across multiple closeSpan calls for the same label set', () => {
    const traceId = randomUUID();
    store.insertTrace({ traceId, kind: 'turn', startTs: Date.now(), subjectId: 'engineer' });

    for (let i = 0; i < 3; i++) {
      const spanId = openLlmCallSpan(traceId, 'claude-sonnet-5');
      store.closeSpan(spanId, 'ok', {
        inputTokens: 10,
        outputTokens: 5,
        estimatedCostUsd: 0.001,
        provider: 'anthropic',
        costBasis: 'priced',
      });
    }

    const rows = store.getMetricCounters();
    const labels = { personality: 'engineer', provider: 'anthropic', model: 'claude-sonnet-5' };
    expect(counterFor(rows, 'ethos_llm_tokens_total', { ...labels, kind: 'input' })?.value).toBe(
      30,
    );
    // One row per unique label set, not one row per call.
    expect(rows.filter((r) => r.metric === 'ethos_llm_cost_usd_total')).toHaveLength(1);
  });

  it('does not double-count a span closed twice', () => {
    const traceId = randomUUID();
    store.insertTrace({ traceId, kind: 'turn', startTs: Date.now(), subjectId: 'engineer' });
    const spanId = openLlmCallSpan(traceId, 'claude-sonnet-5');

    const attrs = {
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostUsd: 0.001,
      provider: 'anthropic',
      costBasis: 'priced' as const,
    };
    store.closeSpan(spanId, 'ok', attrs);
    store.closeSpan(spanId, 'ok', attrs);

    const rows = store.getMetricCounters();
    const labels = { personality: 'engineer', provider: 'anthropic', model: 'claude-sonnet-5' };
    expect(counterFor(rows, 'ethos_llm_tokens_total', { ...labels, kind: 'input' })?.value).toBe(
      10,
    );
  });
});

describe('closeSpan(tool_call) — counters', () => {
  it('increments call count and duration histogram using attrs.durationMs', () => {
    const traceId = randomUUID();
    store.insertTrace({ traceId, kind: 'turn', startTs: Date.now() });
    const spanId = randomUUID();
    const span: Span = {
      spanId,
      traceId,
      kind: 'tool_call',
      name: 'read_file',
      startTs: Date.now(),
    };
    store.insertSpan(span);

    store.closeSpan(spanId, 'ok', { durationMs: 120 });

    const rows = store.getMetricCounters();
    expect(
      counterFor(rows, 'ethos_tool_calls_total', { tool: 'read_file', outcome: 'ok' })?.value,
    ).toBe(1);
    expect(
      counterFor(rows, 'ethos_tool_duration_seconds_sum', { tool: 'read_file' })?.value,
    ).toBeCloseTo(0.12);
    expect(
      counterFor(rows, 'ethos_tool_duration_seconds_bucket', { tool: 'read_file', le: '0.25' })
        ?.value,
    ).toBe(1);
  });

  it('records error outcome separately from ok', () => {
    const traceId = randomUUID();
    store.insertTrace({ traceId, kind: 'turn', startTs: Date.now() });
    const spanId = randomUUID();
    store.insertSpan({ spanId, traceId, kind: 'tool_call', name: 'bash', startTs: Date.now() });
    store.closeSpan(spanId, 'error', { durationMs: 10 });

    const rows = store.getMetricCounters();
    expect(
      counterFor(rows, 'ethos_tool_calls_total', { tool: 'bash', outcome: 'error' })?.value,
    ).toBe(1);
    expect(
      counterFor(rows, 'ethos_tool_calls_total', { tool: 'bash', outcome: 'ok' }),
    ).toBeUndefined();
  });
});

describe('closeTrace — ethos_turn_outcomes_total', () => {
  it('increments with personality and platform for a turn trace', () => {
    const traceId = randomUUID();
    store.insertTrace({
      traceId,
      kind: 'turn',
      startTs: Date.now(),
      subjectId: 'engineer',
      attrs: { platform: 'telegram' },
    });
    store.closeTrace(traceId, 'ok');

    const rows = store.getMetricCounters();
    expect(
      counterFor(rows, 'ethos_turn_outcomes_total', {
        personality: 'engineer',
        platform: 'telegram',
        status: 'ok',
      })?.value,
    ).toBe(1);
  });

  it('does not count a non-turn trace kind', () => {
    const traceId = randomUUID();
    store.insertTrace({ traceId, kind: 'cron.tick', startTs: Date.now() });
    store.closeTrace(traceId, 'ok');

    const rows = store.getMetricCounters();
    expect(rows.filter((r) => r.metric === 'ethos_turn_outcomes_total')).toHaveLength(0);
  });

  it('does not double-count a trace closed twice', () => {
    const traceId = randomUUID();
    store.insertTrace({
      traceId,
      kind: 'turn',
      startTs: Date.now(),
      attrs: { platform: 'cli' },
    });
    store.closeTrace(traceId, 'ok');
    store.closeTrace(traceId, 'ok');

    const rows = store.getMetricCounters();
    expect(
      counterFor(rows, 'ethos_turn_outcomes_total', {
        personality: 'unknown',
        platform: 'cli',
        status: 'ok',
      })?.value,
    ).toBe(1);
  });
});

describe('insertEvent — ethos_skill_invocations_total', () => {
  function skillEvent(category: 'skill.invoked' | 'skill.exposed', skill: string): ObsEvent {
    return {
      eventId: randomUUID(),
      ts: Date.now(),
      category,
      severity: 'info',
      details: { skill },
    };
  }

  it('increments for skill.invoked and skill.exposed as separate modes', () => {
    store.insertEvent(skillEvent('skill.invoked', 'writing'));
    store.insertEvent(skillEvent('skill.exposed', 'writing'));
    store.insertEvent(skillEvent('skill.exposed', 'writing'));

    const rows = store.getMetricCounters();
    expect(
      counterFor(rows, 'ethos_skill_invocations_total', { skill: 'writing', mode: 'invoked' })
        ?.value,
    ).toBe(1);
    expect(
      counterFor(rows, 'ethos_skill_invocations_total', { skill: 'writing', mode: 'exposed' })
        ?.value,
    ).toBe(2);
  });

  it('ignores other event categories', () => {
    store.insertEvent({
      eventId: randomUUID(),
      ts: Date.now(),
      category: 'audit.transition',
      severity: 'info',
    });
    expect(store.getMetricCounters()).toEqual([]);
  });

  it('does not double-count a duplicate event_id', () => {
    const event = skillEvent('skill.invoked', 'writing');
    store.insertEvent(event);
    store.insertEvent(event); // same eventId — INSERT OR IGNORE no-ops

    const rows = store.getMetricCounters();
    expect(
      counterFor(rows, 'ethos_skill_invocations_total', { skill: 'writing', mode: 'invoked' })
        ?.value,
    ).toBe(1);
  });
});

describe('insertEvent — ethos_memory_writes_total', () => {
  function memoryWriteEvent(store: string, action: string): ObsEvent {
    return {
      eventId: randomUUID(),
      ts: Date.now(),
      category: 'memory.write',
      severity: 'info',
      details: { store, action },
    };
  }

  it('increments for a memory.write event, labeled by store and action', () => {
    store.insertEvent(memoryWriteEvent('memory', 'add'));
    store.insertEvent(memoryWriteEvent('memory', 'add'));
    store.insertEvent(memoryWriteEvent('team', 'replace'));

    const rows = store.getMetricCounters();
    expect(
      counterFor(rows, 'ethos_memory_writes_total', { store: 'memory', action: 'add' })?.value,
    ).toBe(2);
    expect(
      counterFor(rows, 'ethos_memory_writes_total', { store: 'team', action: 'replace' })?.value,
    ).toBe(1);
  });

  it('does not double-count a duplicate event_id', () => {
    const event = memoryWriteEvent('user', 'remove');
    store.insertEvent(event);
    store.insertEvent(event); // same eventId — INSERT OR IGNORE no-ops

    const rows = store.getMetricCounters();
    expect(
      counterFor(rows, 'ethos_memory_writes_total', { store: 'user', action: 'remove' })?.value,
    ).toBe(1);
  });

  it('ignores a memory.write event missing store/action details', () => {
    store.insertEvent({
      eventId: randomUUID(),
      ts: Date.now(),
      category: 'memory.write',
      severity: 'info',
    });
    expect(store.getMetricCounters()).toEqual([]);
  });
});

describe('recordHttpRequest — ethos_http_requests_total', () => {
  it('increments, labeled by method and status', () => {
    store.recordHttpRequest('GET', 200);
    store.recordHttpRequest('GET', 200);
    store.recordHttpRequest('POST', 404);

    const rows = store.getMetricCounters();
    expect(
      counterFor(rows, 'ethos_http_requests_total', { method: 'GET', status: '200' })?.value,
    ).toBe(2);
    expect(
      counterFor(rows, 'ethos_http_requests_total', { method: 'POST', status: '404' })?.value,
    ).toBe(1);
  });
});

describe('D19 — label cardinality', () => {
  it('no forbidden per-call id ever appears as a label key on a written row', () => {
    const traceId = randomUUID();
    store.insertTrace({
      traceId,
      sessionId: 'sess-1',
      kind: 'turn',
      startTs: Date.now(),
      subjectId: 'engineer',
      attrs: { platform: 'telegram' },
    });
    const llmSpan = openLlmCallSpan(traceId, 'claude-sonnet-5');
    store.closeSpan(llmSpan, 'ok', {
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostUsd: 0,
      provider: 'anthropic',
      costBasis: 'priced',
      clientRequestId: 'req-abc',
      providerRequestId: 'prov-xyz',
    });
    const toolSpanId = randomUUID();
    store.insertSpan({
      spanId: toolSpanId,
      traceId,
      kind: 'tool_call',
      name: 'read_file',
      startTs: Date.now(),
    });
    store.closeSpan(toolSpanId, 'ok', { durationMs: 5 });
    store.insertEvent({
      eventId: randomUUID(),
      traceId,
      ts: Date.now(),
      category: 'skill.invoked',
      severity: 'info',
      details: { skill: 'writing' },
    });
    store.closeTrace(traceId, 'ok');

    const rows = store.getMetricCounters();
    for (const row of rows) {
      for (const forbidden of FORBIDDEN_LABEL_KEYS) {
        expect(Object.keys(row.labels)).not.toContain(forbidden);
      }
    }
  });
});
