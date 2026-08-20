import type { ClarifyRequestEvent, SseEvent } from '@ethosagent/web-contracts';

// The question queue, as a pure reducer (pi-delegation D9).
//
// A clarify occupies one lane — `jobId ?? sessionId` (G1/D22) — so at most one
// question is ever pending per run, and a question that belongs to a run is
// drawn INSIDE that run's card rather than as a floating modal (§4.5). A
// question with no `jobId` is a foreground clarify and keeps today's behaviour.
//
// Resolved rows are kept rather than dropped: §4.5 is explicit that the
// resolved state replaces the card body in place and does not disappear,
// because the transcript is where the decision lives afterwards.

export type ClarifyResolution = 'user' | 'timeout-default' | 'timeout-no-default' | 'cancel';

export interface ResolvedClarify {
  requestId: string;
  /** The run this question belonged to; absent for a foreground clarify. */
  jobId?: string;
  question: string;
  /**
   * The answer, when this browser is the one that supplied it. `clarify.resolved`
   * carries only the source, so a question settled on another surface resolves
   * here with a null answer rather than an invented one.
   */
  answer: string | null;
  source: ClarifyResolution;
  resolvedAt: number;
}

export interface ClarifyQueueState {
  pending: ClarifyRequestEvent[];
  resolved: ResolvedClarify[];
}

export const emptyClarifyQueue: ClarifyQueueState = { pending: [], resolved: [] };

/** Resolved questions worth keeping in view. Older decisions age out. */
export const RESOLVED_CAP = 20;

export function applyClarifyEvent(
  prev: ClarifyQueueState,
  event: SseEvent,
  now: number,
): ClarifyQueueState {
  switch (event.type) {
    case 'clarify.request': {
      // Dedupe by requestId — an SSE reconnect re-delivering the row is a no-op.
      if (prev.pending.some((c) => c.requestId === event.requestId)) return prev;
      return { ...prev, pending: [...prev.pending, event] };
    }
    case 'clarify.resolved': {
      const row = prev.pending.find((c) => c.requestId === event.requestId);
      if (!row) return prev;
      const already = prev.resolved.find((r) => r.requestId === event.requestId);
      const settled: ResolvedClarify = {
        requestId: row.requestId,
        ...(row.jobId !== undefined ? { jobId: row.jobId } : {}),
        question: row.question,
        answer: already?.answer ?? null,
        source: event.source,
        resolvedAt: now,
      };
      return {
        pending: prev.pending.filter((c) => c.requestId !== event.requestId),
        resolved: [settled, ...prev.resolved.filter((r) => r.requestId !== event.requestId)].slice(
          0,
          RESOLVED_CAP,
        ),
      };
    }
    default:
      return prev;
  }
}

/**
 * Record the answer this tab submitted, before the round trip. Without it the
 * resolved card can say a question was answered but not what the answer was —
 * `clarify.resolved` does not carry it.
 */
export function noteAnswer(
  prev: ClarifyQueueState,
  requestId: string,
  answer: string,
  now: number,
): ClarifyQueueState {
  const row = prev.pending.find((c) => c.requestId === requestId);
  const existing = prev.resolved.find((r) => r.requestId === requestId);
  if (existing) {
    return {
      ...prev,
      resolved: prev.resolved.map((r) => (r.requestId === requestId ? { ...r, answer } : r)),
    };
  }
  if (!row) return prev;
  const settled: ResolvedClarify = {
    requestId,
    ...(row.jobId !== undefined ? { jobId: row.jobId } : {}),
    question: row.question,
    answer,
    source: 'user',
    resolvedAt: now,
  };
  return { ...prev, resolved: [settled, ...prev.resolved].slice(0, RESOLVED_CAP) };
}

/** The one question a run is parked on, if any. */
export function questionForRun(
  state: ClarifyQueueState,
  jobId: string,
): ClarifyRequestEvent | undefined {
  return state.pending.find((c) => c.jobId === jobId);
}

/** The most recent decision made on a run, kept in view per §4.5. */
export function resolvedForRun(
  state: ClarifyQueueState,
  jobId: string,
): ResolvedClarify | undefined {
  return state.resolved.find((r) => r.jobId === jobId);
}

/**
 * Questions that belong to no run — the foreground `clarify` tool. These keep
 * rendering through the existing floating card, untouched by this plan.
 */
export function foregroundQuestions(state: ClarifyQueueState): ClarifyRequestEvent[] {
  return state.pending.filter((c) => c.jobId === undefined);
}

/** How many runs are parked on a question — the number behind the nav badge. */
export function runQuestionCount(state: ClarifyQueueState): number {
  return state.pending.filter((c) => c.jobId !== undefined).length;
}
