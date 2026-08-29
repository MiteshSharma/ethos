import { randomUUID } from 'node:crypto';
import type { SQLiteObservabilityStore } from '@ethosagent/observability-sqlite';
import { postToLangfuse } from './client';
import { buildLangfuseBatch } from './mapping';

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 50;
/** How long a claim survives before the next tick treats it as abandoned
 *  (a crashed poller) and re-claims the trace. Short on purpose — a single
 *  export POST is not a long-running operation, unlike the delivery
 *  ledger's day-scale `abandonStale`. */
const DEFAULT_STALE_CLAIM_CUTOFF_MS = 120_000;

export interface LangfusePollConfig {
  store: SQLiteObservabilityStore;
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  /** Poll interval. Default 15000ms. */
  intervalMs?: number;
  /** Traces claimed per tick. Default 50. */
  batchSize?: number;
  /** Default 120000ms (2 minutes). */
  staleClaimCutoffMs?: number;
  onError?: (err: Error) => void;
}

export interface LangfuseTickResult {
  exported: number;
  failed: number;
  skipped: number;
}

/**
 * Self-rescheduling claim -> export -> stamp-or-release poller, mirroring
 * `KanbanPollLoop` (apps/ethos/src/lib/kanban-poll.ts): `setTimeout` only
 * reschedules after the previous tick fully finishes, never a bare
 * `setInterval` with overlapping ticks. Runs wherever wired (gateway and/or
 * serve) — the store's atomic claim keeps concurrent pollers from exporting
 * the same trace twice.
 */
export class LangfusePollLoop {
  private readonly store: SQLiteObservabilityStore;
  private readonly clientConfig: { baseUrl: string; publicKey: string; secretKey: string };
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly staleClaimCutoffMs: number;
  private readonly onError?: (err: Error) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(config: LangfusePollConfig) {
    this.store = config.store;
    this.clientConfig = {
      baseUrl: config.baseUrl,
      publicKey: config.publicKey,
      secretKey: config.secretKey,
    };
    this.intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
    this.staleClaimCutoffMs = config.staleClaimCutoffMs ?? DEFAULT_STALE_CLAIM_CUTOFF_MS;
    this.onError = config.onError;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (err) {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
      if (this.running) {
        this.timer = setTimeout(loop, this.intervalMs);
      }
    };
    void loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * One claim -> work -> release-or-stamp pass, mirroring
   * `Gateway.sweepPendingDeliveries()`'s shape (extensions/gateway/src/index.ts):
   * claim, try the send, release the claim on ANY failure — including inside
   * the `catch` — so a thrown error never leaves a trace stuck claimed.
   */
  async tick(): Promise<LangfuseTickResult> {
    const claimed = this.store.claimUnexportedTraces(this.batchSize, this.staleClaimCutoffMs);
    let exported = 0;
    let failed = 0;
    let skipped = 0;
    for (const { trace, claimedAt } of claimed) {
      try {
        const spans = this.store.getSpans(trace.traceId);
        if (spans.length === 0) {
          // Retention pruning outran export (or the trace genuinely closed
          // with no spans) — nothing left to ship. Stamp it exported so it
          // stops being re-claimed forever, and log rather than silently
          // dropping it.
          this.store.markTraceExported(trace.traceId, claimedAt);
          this.logEvent(
            trace.traceId,
            'export.langfuse_skipped_pruned',
            'info',
            'no spans at export time',
          );
          skipped++;
          continue;
        }
        const events = this.store.getEventsByTraceIds([trace.traceId]);
        const batch = buildLangfuseBatch(trace, spans, events);
        const ok = await postToLangfuse(batch, this.clientConfig);
        if (ok) {
          this.store.markTraceExported(trace.traceId, claimedAt);
          exported++;
        } else {
          this.store.releaseTraceClaim(trace.traceId, claimedAt);
          this.logEvent(
            trace.traceId,
            'export.langfuse_failed',
            'warn',
            'non-2xx response from Langfuse',
          );
          failed++;
        }
      } catch (err) {
        this.store.releaseTraceClaim(trace.traceId, claimedAt);
        this.logEvent(
          trace.traceId,
          'export.langfuse_failed',
          'warn',
          err instanceof Error ? err.message : String(err),
        );
        failed++;
      }
    }
    return { exported, failed, skipped };
  }

  private logEvent(
    traceId: string,
    category: string,
    severity: 'info' | 'warn',
    cause: string,
  ): void {
    try {
      this.store.insertEvent({
        eventId: randomUUID(),
        traceId,
        ts: Date.now(),
        category,
        severity,
        cause,
      });
    } catch {
      // Fail-open: a failure logging the failure must not throw out of tick().
    }
  }
}
