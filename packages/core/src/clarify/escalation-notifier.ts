// Clarify escalation — §4.6 rung 3 of plan/phases/pi-delegation.md.
//
// The ladder escalates on SILENCE, never on time alone:
//
//   rung 1  t=0     you are on that session      question expands in the run card
//   rung 2  t=0     you are elsewhere in Ethos   pill + badge + drawer row
//   rung 3  t=60s   still unanswered             PUSH to the run's ORIGIN LANE   ← here
//   rung 4  t=timeout                            default applies, or the run parks
//
// Rung 3 is a nudge about a question that is already pending somewhere, not a
// second question: it carries no options and resolves nothing. Answering the
// original clarify anywhere removes the pending row, and the next sweep then
// has nothing to push — which is also how the drawer's notice clears.
//
// Why a sweep and not a per-request `setTimeout`: the push must survive a
// restart (a process that died at t=30s must still escalate at t=60s), and it
// must be safe for two processes to attempt at once. A sweep over the SHARED
// clarify store gives both for free, and `JobStore.claimNotice` — the second
// delivery claim, keyed by `requestId` (G5) — is what makes two processes
// racing the same question push it exactly once.

import type { BackgroundJob, ClarifyStore, JobStore, PendingClarify } from '@ethosagent/types';

/** Where a mid-run notice is pushed: the run's recorded origin lane. */
export interface ClarifyNoticeTarget {
  platform: string;
  botKey?: string;
  chatId: string;
  threadId?: string;
}

export interface ClarifyEscalationDeps {
  /** The SHARED pending-clarify store — the same rows every process sweeps. */
  store: ClarifyStore;
  /** `claimNotice`/`releaseNotice` are G5's second claim; `get` resolves the run. */
  jobs: Pick<JobStore, 'get' | 'claimNotice' | 'releaseNotice'>;
  /**
   * The job's origin lane, or `null` to skip it — no recorded origin, a
   * platform with no channel to push to, or a bot this process does not own
   * (an obligation filed under someone else's botKey is a lost message).
   */
  resolveTarget(job: BackgroundJob): ClarifyNoticeTarget | null;
  /**
   * Send the notice through the DURABLE outbound path (delivery ledger:
   * `pending` obligation written before the platform call, `delivered` only on
   * `DeliveryResult.ok === true`). Returns whether the platform CONFIRMED.
   */
  notify(target: ClarifyNoticeTarget, text: string): Promise<boolean>;
  /**
   * Whether an unconfirmed `notify` leaves a durable retry behind (i.e. a
   * delivery ledger is wired). When it does, the claim is KEPT so the ledger's
   * sweep owns the retry and the notice is not sent twice; when it does not,
   * the claim is released so the next sweep can try again. Same rule the
   * gateway's completion-notice restore sweep already follows.
   */
  durableRetry: boolean;
  /** Silence before rung 3 fires, measured from `presentedAt` (D2). Default 60s. */
  delayMs?: number;
  onError?(stage: string, err: unknown, details: Record<string, unknown>): void;
}

/** §4.6 rung 3 — 60 seconds of silence after the question was PRESENTED. */
export const DEFAULT_ESCALATION_DELAY_MS = 60_000;

const NON_TERMINAL = new Set(['queued', 'running', 'blocked']);

/**
 * The pushed text. Short on purpose: the question itself is already pending on
 * some surface with its own options and its own answer path — this is the
 * "you have not answered" tap on the shoulder, not a second card.
 */
export function buildClarifyEscalationNotice(row: PendingClarify, job: BackgroundJob): string {
  const label = job.label ?? job.id.slice(0, 8);
  return `Needs you — run ${label} is waiting on an answer.\n\n${row.question}`;
}

/**
 * One escalation pass. Returns what it did, for observability and tests.
 *
 * Skips, in order: rows with no job (a foreground clarify has a human in front
 * of it), rows still queued (`presentedAt` null — D2: the clock starts at
 * presentation, never at request), rows already answered, rows younger than
 * `delayMs`, jobs that are gone or terminal, jobs with no pushable origin lane,
 * and finally rows whose claim a peer process won.
 */
export async function sweepClarifyEscalations(
  deps: ClarifyEscalationDeps,
  now: number = Date.now(),
): Promise<{ pushed: number; failed: number }> {
  const delayMs = deps.delayMs ?? DEFAULT_ESCALATION_DELAY_MS;
  let pushed = 0;
  let failed = 0;

  let rows: PendingClarify[];
  try {
    rows = await deps.store.list();
  } catch (err) {
    deps.onError?.('list', err, {});
    return { pushed, failed };
  }

  for (const row of rows) {
    const jobId = row.jobId;
    if (jobId === undefined) continue;
    if (row.answer) continue;
    const presentedAt = row.presentedAt;
    if (!presentedAt) continue;
    const presentedMs = new Date(presentedAt).getTime();
    if (!Number.isFinite(presentedMs) || now - presentedMs < delayMs) continue;

    try {
      const job = await deps.jobs.get(jobId);
      if (!job || !NON_TERMINAL.has(job.status)) continue;

      const target = deps.resolveTarget(job);
      if (!target) continue;

      // The claim goes BEFORE the send, and losing it means a peer is sending.
      if (!(await deps.jobs.claimNotice(row.requestId, jobId))) continue;

      const ok = await deps.notify(target, buildClarifyEscalationNotice(row, job));
      if (ok) {
        pushed++;
        continue;
      }
      failed++;
      if (!deps.durableRetry) await deps.jobs.releaseNotice(row.requestId);
    } catch (err) {
      failed++;
      deps.onError?.('push', err, { requestId: row.requestId, jobId });
    }
  }

  return { pushed, failed };
}
