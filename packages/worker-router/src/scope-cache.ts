import type { InteractionAnswer } from '@ethosagent/types';

/**
 * D17 — answers that stand beyond the ask they were given for, keyed by
 * `(jobId, kind, toolName)`.
 *
 * Per-JOB, never global: two runs of the same task are two different decisions,
 * and a human who allowed `bash` for one run has not allowed it for the next
 * one. The job's terminal transition drops its whole bucket (`forgetJob`).
 *
 * KNOWN GAP — `'always'` is stored here exactly like `'run'`, so it does not
 * survive a process restart. Cross-restart persistence needs a durable store
 * and a UI that can revoke what it wrote; neither exists yet, and an `'always'`
 * a user cannot see or take back is worse than one that quietly expires with
 * the process. Recorded in plan/phases/pi-delegation.md §15 (I19).
 */
export class InteractionScopeCache {
  /** jobId → `${kind} ${toolName}` → answer. Nested so a job drops in O(1). */
  private readonly byJob = new Map<string, Map<string, InteractionAnswer>>();

  private static key(kind: string, toolName?: string): string {
    return `${kind} ${toolName ?? ''}`;
  }

  get(jobId: string, kind: string, toolName?: string): InteractionAnswer | undefined {
    return this.byJob.get(jobId)?.get(InteractionScopeCache.key(kind, toolName));
  }

  remember(
    jobId: string,
    kind: string,
    toolName: string | undefined,
    answer: InteractionAnswer,
  ): void {
    const bucket = this.byJob.get(jobId) ?? new Map<string, InteractionAnswer>();
    bucket.set(InteractionScopeCache.key(kind, toolName), answer);
    this.byJob.set(jobId, bucket);
  }

  /** Called on a job's terminal transition — nothing about a finished run stands. */
  forgetJob(jobId: string): void {
    this.byJob.delete(jobId);
  }
}
