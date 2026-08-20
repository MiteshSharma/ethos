import type { ClarifyBridge } from '@ethosagent/core';
import type {
  ClarifyResponse,
  ClarifySurfaceType,
  InteractionAnswer,
  JobStore,
} from '@ethosagent/types';
import type { InteractionEscalator } from './router';
import { SecretUnavailableError } from './secret';

/** Matches the `clarify` tool's own window (`clarify-tool.ts`, 15 min). */
export const DEFAULT_ESCALATION_TIMEOUT_MS = 900_000;

/**
 * D17 — a clarify card has no scope control of its own, so the scope rides the
 * ANSWER TEXT: a surface offers this string as one of the options and the
 * escalator reads the scope back off whatever the human picked. Anything else
 * (free text, a different option, a timeout default) is `'once'` — the scope
 * that promises nothing.
 *
 * This is the demo's "Allow for this run" button given somewhere to live. It is
 * a runner-agnostic convention on purpose: OpenCode's `remember` flag would map
 * onto the same `InteractionAnswer.scope`.
 */
export const RUN_SCOPE_ANSWER = 'Allow for this run';

export interface ClarifyEscalatorDeps {
  bridge: Pick<ClarifyBridge, 'request'>;
  /** Resolves the asking job — its `childSessionKey` is the clarify's session. */
  jobs: Pick<JobStore, 'get'>;
  /**
   * Route of last resort. A background clarify's REAL route is resolved inside
   * `ClarifyBridge` (origin lane + presence, G2/G3/D7) because `jobId` is set;
   * this is only what the bridge falls back to when a job has no recorded
   * origin.
   */
  fallbackSurfaceType?: ClarifySurfaceType;
  timeoutMs?: number;
  /**
   * I11 — park the run on `blocked` while a human is being asked, and un-park
   * it when the question settles. Supplied as a PAIR or not at all: a `block`
   * with no `resume` leaves a run marked `blocked` that nothing ever clears.
   *
   * Injected rather than imported. `BackgroundExecutor` — whose
   * `markJobBlocked` / `resumeJob` are what this pair binds to — lives in
   * `extensions/job-runner`, and this package sits BELOW extensions
   * (ARCHITECTURE.md §II: only `packages/wiring` may name an extension). Going
   * through `JobStore` instead would type-check, but it would set the row's
   * status without pausing the executor's per-job heartbeat, which is half the
   * meaning of `blocked`.
   */
  blocking?: {
    block(jobId: string, requestId: string): Promise<void>;
    resume(jobId: string): Promise<void>;
  };
}

/**
 * Escalate an interaction to a human over the existing clarify chain.
 *
 * The whole point of routing through `ClarifyBridge` rather than a second
 * question mechanism: per-job FIFO lanes (G1), present-time deadlines (D2),
 * origin-lane routing (G2/G3/D7), cross-process answer delivery, and restart
 * hydration all already work, and a worker's question is not special enough to
 * deserve its own copy of any of it.
 */
export function createClarifyEscalator(deps: ClarifyEscalatorDeps): InteractionEscalator {
  return async (jobId, req) => {
    // `sensitive` is the same rule the `secret` handler enforces by kind,
    // applied at the only place that would actually persist the answer. A
    // harness that marks a request sensitive has said "do not write this
    // down"; a clarify row IS writing it down.
    if (req.sensitive) {
      throw new SecretUnavailableError(
        `request '${req.requestId}' (kind '${req.kind}') is marked sensitive; refusing to route it to a persisted clarify row`,
      );
    }

    const job = await deps.jobs.get(jobId);
    const options = req.options?.map((o) => o.label) ?? [];
    // Park the run BEFORE the await starts blocking, and AWAIT the park: a
    // surface that answers instantly must not resume a job that is not marked
    // blocked yet, which would leave the row `blocked` forever.
    //
    // The id recorded is the INTERACTION's `requestId`, not the clarify row's.
    // `ClarifyBridge` mints its own id inside `request()` and no caller can
    // read it before the promise settles, so `BackgroundJob.blockedRequestId`
    // cannot in fact hold a `PendingClarify.requestId` for either of the
    // callers its doc names. The join a surface actually needs — parked run to
    // pending question — is `jobId`, which IS the clarify's lane (G1) and is
    // already queryable via `ClarifyBridge.listPending`.
    await deps.blocking?.block(jobId, req.requestId);
    let response: ClarifyResponse;
    try {
      // Rejects with `ClarifyTimedOutNoDefaultError` when the window closes and
      // the harness supplied no default — the run parks instead of guessing
      // (§4.5's default policy). Deliberately not caught here.
      response = await deps.bridge.request({
        question: req.prompt,
        ...(options.length > 0 ? { options } : {}),
        ...(req.defaultValue !== undefined ? { default: req.defaultValue } : {}),
        timeoutMs: deps.timeoutMs ?? DEFAULT_ESCALATION_TIMEOUT_MS,
        answerableBy: 'anyone',
        // The run's own session, so the question lands on the run's stream. The
        // lane it queues in is the JOB (G1), which is passed separately.
        sessionId: job?.childSessionKey ?? jobId,
        jobId,
        surfaceType: deps.fallbackSurfaceType ?? 'web',
      });
    } finally {
      // Answered, cancelled, or timed out with no default — whichever way it
      // settled, the run is no longer waiting on a human. Resuming on the
      // reject path too is the point of the `finally`: a rejected escalation
      // becomes a denied tool call and the run keeps going.
      await deps.blocking?.resume(jobId);
    }

    return {
      requestId: req.requestId,
      value: response.answer,
      scope:
        response.source === 'user' && response.answer.trim() === RUN_SCOPE_ANSWER ? 'run' : 'once',
      source:
        response.source === 'user'
          ? 'human'
          : response.source === 'cancel'
            ? 'cancel'
            : 'timeout-default',
    } satisfies InteractionAnswer;
  };
}
