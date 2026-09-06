import { ORPCError } from '@orpc/server';
import { CLARIFY_UNRESOLVED_REASON, respondAndConfirm } from '../clarify-resolution';
import { os } from './context';

// Thin RPC shell for the clarify namespace. Resolves a pending clarify
// request registered by the `clarify` tool; the request side flows out over
// SSE (`clarify.request`) and the resolution back over SSE (`clarify.resolved`)
// so every tab on the session sees the card collapse. Mirrors `tools.approve`.
//
// The `requestId` is an opaque random UUID only surfaced to browsers
// subscribed to the owning session's SSE stream — the same reachability
// posture as `approvalId` in the tool-approval transport.

/**
 * Runs that can no longer be waiting on an answer. Mirrors `isTerminalRun` in
 * `apps/web/src/lib/pi-run-reducer.ts` — the same three statuses the chat page
 * declines to redraw a card for, so the two halves of the restore agree on
 * which runs are still live.
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'failed', 'aborted']);

export const clarifyRouter = {
  /**
   * Answer one pending clarify. `{ ok: true }` means the row was RESOLVED —
   * nothing weaker, and `respondAndConfirm` is what enforces it.
   *
   * Both ways this can resolve nothing used to report success: optional
   * chaining returned `{ ok: true }` with no bridge at all, and
   * `ClarifyBridge.respond()` swallows a request it cannot resolve. This is
   * the takeover's FALLBACK hand-back (`TakeoverMode.handBack`), so either one
   * told an operator the browser was back with the agent while it stayed
   * parked. Failure THROWS because the contract's output is `z.literal(true)`
   * — no other channel exists — and both callers already render the message.
   */
  respond: os.clarify.respond.handler(async ({ input, context }) => {
    const bridge = context.clarifyBridge;
    if (!bridge) {
      throw new ORPCError('CLARIFY_UNAVAILABLE', {
        status: 503,
        message: 'This Ethos process has no clarify bridge — the answer went nowhere.',
      });
    }
    // D7 — a human acted on this surface; a background job's next question
    // may route here instead of always falling back to its origin lane.
    bridge.recordPresence('web');
    const resolved = await respondAndConfirm(bridge, {
      requestId: input.requestId,
      answer: input.answer,
      source: input.source,
    });
    if (!resolved) {
      throw new ORPCError('CLARIFY_NOT_RESOLVED', {
        status: 409,
        message: `That answer did not land: ${CLARIFY_UNRESOLVED_REASON}.`,
      });
    }
    return { ok: true as const };
  }),

  /**
   * The open questions this session's live runs are parked on.
   *
   * The catch-up read the `clarify.request` push has never had. That push is
   * live-only — a page that mounts after the question was asked (reload, tab
   * change, the `key={personalityId}` remount a personality switch forces)
   * receives nothing, and the run card then draws a run that says "waiting on
   * you" with no way to see or answer what it is waiting for.
   *
   * Scoping is by JOB, not by clarify `sessionId`: a delegated run asks on its
   * child session key (see `createClarifyEscalator`), so a `sessionId` filter
   * would match nothing a browser knows about. `BackgroundJob.blockedRequestId`
   * is not the join either — it holds the INTERACTION id, not the clarify row's
   * (that file says so explicitly). The lane IS the job (G1), which is what
   * both `ClarifyStore.list` and the run card key on.
   */
  listPending: os.clarify.listPending.handler(async ({ input, context }) => {
    const bridge = context.clarifyBridge;
    if (!bridge) return [];
    const jobs = await context.tasks.list(input.rootSessionKey);
    const live = new Set(jobs.filter((j) => !TERMINAL_STATUSES.has(j.status)).map((j) => j.id));
    if (live.size === 0) return [];
    // One store read for every job rather than one per job: `list()` reads the
    // whole pending file either way, and this endpoint is called once per chat
    // mount. `surfaceType` narrows to rows that routed HERE — a question that
    // escalated to Telegram is being asked somewhere else, and answering it
    // from a card the web never presented would be a second prompt, not a
    // catch-up.
    const rows = await bridge.listPersisted({ surfaceType: 'web' });
    const pending: Array<{
      requestId: string;
      jobId: string;
      question: string;
      options?: string[];
      default?: string;
      defaultDeadlineAt: string;
    }> = [];
    for (const row of rows) {
      const { jobId, defaultDeadlineAt } = row;
      if (jobId === undefined || !live.has(jobId)) continue;
      // A row still QUEUED behind another question in its lane has no timer and
      // has been shown to nobody (D2) — presenting it here would jump the FIFO.
      if (defaultDeadlineAt === null) continue;
      // Answered in another process and not yet collected by the owner (the
      // cross-process delivery path). The question is settled; only the
      // bookkeeping is outstanding.
      if (row.answer) continue;
      pending.push({
        requestId: row.requestId,
        jobId,
        question: row.question,
        ...(row.options ? { options: row.options } : {}),
        ...(row.default !== undefined ? { default: row.default } : {}),
        defaultDeadlineAt,
      });
    }
    return pending;
  }),
};
