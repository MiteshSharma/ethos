import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { BlobStore } from '../blob-store';
import { ObservabilityService } from '../service';
import { SQLiteObservabilityStore } from '../store';

function makeService() {
  const store = new SQLiteObservabilityStore(join(tmpdir(), `obs-svc-${randomUUID()}.db`));
  const blobStore = new BlobStore('/blobs', new InMemoryStorage());
  const service = new ObservabilityService(store, blobStore);
  return { service, store };
}

describe('ObservabilityService redaction policy', () => {
  it("level 'none': args not stored in span attrs", () => {
    const { service, store } = makeService();
    const traceId = service.startTrace({ kind: 'turn', redaction: { level: 'none' } });
    const spanId = service.startSpan({
      traceId,
      kind: 'tool_call',
      name: 'bash',
      attrs: { args: 'rm -rf /' },
      redaction: { level: 'none' },
    });
    service.endSpan(spanId, 'ok');
    const spans = store.getSpans(traceId);
    expect(spans[0]?.attrs?.args).toBeUndefined();
  });

  it("level 'redacted' (default): args stored with redaction", () => {
    const { service, store } = makeService();
    const awsKey = `AKIA${'A'.repeat(16)}`;
    const traceId = service.startTrace({ kind: 'turn' });
    const spanId = service.startSpan({
      traceId,
      kind: 'tool_call',
      name: 'bash',
      attrs: { args: `key=${awsKey}` },
    });
    service.endSpan(spanId, 'ok');
    const spans = store.getSpans(traceId);
    expect(spans[0]?.attrs?.args).toContain('[REDACTED');
    expect(spans[0]?.attrs?.args).not.toContain(awsKey);
  });

  it('extraPatterns: consumer-supplied patterns applied on top of floor', () => {
    const { service, store } = makeService();
    const traceId = service.startTrace({ kind: 'turn' });
    const spanId = service.startSpan({
      traceId,
      kind: 'tool_call',
      name: 'bash',
      attrs: { args: 'INTERNAL-DOC-ABCD1234' },
      redaction: { level: 'redacted', extraPatterns: ['INTERNAL-DOC-[A-Z0-9]{8}'] },
    });
    service.endSpan(spanId, 'ok');
    const spans = store.getSpans(traceId);
    expect(spans[0]?.attrs?.args).toContain('[REDACTED:custom]');
    expect(spans[0]?.attrs?.args).not.toContain('INTERNAL-DOC-ABCD1234');
  });

  it("level 'full': built-in floor patterns still apply", () => {
    const { service, store } = makeService();
    const awsKey = `AKIA${'A'.repeat(16)}`;
    const traceId = service.startTrace({ kind: 'turn', redaction: { level: 'full' } });
    const spanId = service.startSpan({
      traceId,
      kind: 'tool_call',
      name: 'bash',
      attrs: { args: `key=${awsKey}` },
      redaction: { level: 'full' },
    });
    service.endSpan(spanId, 'ok');
    const spans = store.getSpans(traceId);
    // Built-in floor patterns always apply — AWS key must be redacted even in 'full' mode
    expect(spans[0]?.attrs?.args).toContain('[REDACTED:aws-key]');
    expect(spans[0]?.attrs?.args).not.toContain(awsKey);
  });

  it("level 'full': consumer extraPatterns are skipped (only floor applies)", () => {
    const { service, store } = makeService();
    const traceId = service.startTrace({ kind: 'turn', redaction: { level: 'full' } });
    const spanId = service.startSpan({
      traceId,
      kind: 'tool_call',
      name: 'bash',
      attrs: { args: 'INTERNAL-DOC-ABCD1234' },
      redaction: { level: 'full', extraPatterns: ['INTERNAL-DOC-[A-Z0-9]{8}'] },
    });
    service.endSpan(spanId, 'ok');
    const spans = store.getSpans(traceId);
    // Consumer extra pattern must NOT fire in 'full' mode
    expect(spans[0]?.attrs?.args).toBe('INTERNAL-DOC-ABCD1234');
    expect(spans[0]?.attrs?.args).not.toContain('[REDACTED:custom]');
  });

  it('redaction policy flows from startTrace to all spans in that trace', () => {
    const { service, store } = makeService();
    const traceId = service.startTrace({
      kind: 'turn',
      redaction: { level: 'none' },
    });
    // Don't pass redaction on startSpan — should inherit from trace
    const spanId = service.startSpan({
      traceId,
      kind: 'tool_call',
      name: 'read_file',
      attrs: { args: '/etc/passwd' },
    });
    service.endSpan(spanId, 'ok');
    const spans = store.getSpans(traceId);
    expect(spans[0]?.attrs?.args).toBeUndefined();
  });

  // The web Activity feed dedupes a durable `tool_call` span against the live
  // `tool_start`/`tool_end` SSE events on `attrs.tool_call_id` (written at
  // packages/core/.../tool-processing.ts). That link is only worth anything if
  // it survives every redaction level — `none` strips args specifically, not
  // the whole attrs bag, and the patterns match VALUES, not keys.
  for (const level of ['none', 'redacted', 'full'] as const) {
    it(`level '${level}': tool_call_id survives redaction`, () => {
      const { service, store } = makeService();
      const traceId = service.startTrace({ kind: 'turn', redaction: { level } });
      const spanId = service.startSpan({
        traceId,
        kind: 'tool_call',
        name: 'bash',
        attrs: { args: 'echo hi', tool_call_id: 'toolu_01ABCdef' },
        redaction: { level, extraPatterns: ['INTERNAL-DOC-[A-Z0-9]{8}'] },
      });
      service.endSpan(spanId, 'ok');
      const spans = store.getSpans(traceId);
      expect(spans[0]?.attrs?.tool_call_id).toBe('toolu_01ABCdef');
    });
  }
});
