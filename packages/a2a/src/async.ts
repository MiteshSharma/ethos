// A2A async task orchestration (plan §10 / §17 Phase 6).
//
// A2aAsyncManager is the RESPONDER-side (this server) task manager. `submit`
// dedupes on the idempotency key, creates a `submitted` task, and runs the
// injected runner in the BACKGROUND: `working` → `completed` / `failed`.
//
// Idempotency (plan §10): a retried `message/send` with the same key MUST NOT
// re-run the loop — tools run and state mutates, so a double `run()` is a real
// side effect. `submit` returns the prior/in-flight task and never calls the
// runner a second time.
//
// Layer-clean: imports `./task-store`, the `A2aTaskRunner` TYPE from `./rpc`
// (type-only — no runtime cycle), and `@ethosagent/types` for `AgentEvent`. No
// core, no extensions, no apps — the runner is injected.
//
// NOTE (T1.5 / D11): an earlier revision also carried a push-back delivery
// path (POSTing the result to the peer's own JSON-RPC server as a
// notification) and an initiator-side tracker class that awaited it. Neither
// ever closed: nothing populated a push target on an outbound send, and there
// was no inbound handler to receive the notification. Both were deleted
// rather than finished — Tier 2 scope if the loop is ever closed (poll via
// spec GetTask).

import type { AgentEvent } from '@ethosagent/types';
import { type A2aAuditSink, safeAudit } from './audit';
import type { A2aTaskRunner } from './rpc';
import { type A2aTask, type A2aTaskStore, isTerminalStatus, newTaskId } from './task-store';

// ---------------------------------------------------------------------------
// Shared AgentEvent → result mapping (plan §10 / Phase 5).
// ---------------------------------------------------------------------------

/**
 * Consume an AgentEvent stream: accumulate `text_delta` as the final text
 * (falling back to `done.text`); `error` → a failure reason. `thinking_delta`
 * and tool events are working updates and are NOT surfaced to the peer —
 * internal reasoning must not cross the trust boundary.
 */
export async function collectAgentRun(
  events: AsyncIterable<AgentEvent>,
): Promise<{ text: string; error?: string }> {
  let out = '';
  let doneText: string | null = null;
  let failure: string | undefined;
  for await (const event of events) {
    switch (event.type) {
      case 'text_delta':
        out += event.text;
        break;
      case 'done':
        doneText = event.text;
        break;
      case 'error':
        failure = event.error;
        break;
      default:
        break;
    }
  }
  const text = out.length > 0 ? out : (doneText ?? '');
  return failure !== undefined ? { text, error: failure } : { text };
}

// ---------------------------------------------------------------------------
// Responder-side async manager
// ---------------------------------------------------------------------------

export interface A2aAsyncManagerOptions {
  taskStore: A2aTaskStore;
  runner: A2aTaskRunner;
  /** Injectable clock (ms epoch). Default `Date.now`. */
  now?: () => number;
  /** Called after a trace's task settles, so the delegation guard can free it. */
  onSettled?: (traceId: string) => void;
  /** Metadata-only audit sink (plan §13 / Phase 8) — records task-state transitions. */
  auditSink?: A2aAuditSink;
}

export interface SubmitAsyncArgs {
  personalityId: string;
  peerFingerprint: string;
  message: string;
  sessionKey: string;
  /**
   * The peer-named skill — threaded to the runner for turn-time tool
   * narrowing (T0.2). Optional so existing test callers that don't exercise
   * narrowing are unaffected; a real inbound `message/send` always supplies
   * it (`A2aMessageSendParams.skill` is a required protocol field).
   */
  skill?: string;
  traceId: string;
  /** Signed delegation depth this task was admitted at — threaded to the runner (P8). */
  depth: number;
  idempotencyKey: string;
}

/** The responder-side async task manager. */
export class A2aAsyncManager {
  private readonly opts: A2aAsyncManagerOptions;
  private readonly now: () => number;
  // task id → the background settle promise (lets callers/tests await settlement).
  private readonly running = new Map<string, Promise<A2aTask>>();

  constructor(opts: A2aAsyncManagerOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Submit an async task. Dedupes on `(peerFingerprint, idempotencyKey)`: a
   * prior/in-flight task is returned WITHOUT re-running the loop. Otherwise a
   * `submitted` task is created and executed in the background.
   */
  async submit(args: SubmitAsyncArgs): Promise<A2aTask> {
    const existing = await this.opts.taskStore.findByIdempotencyKey(
      args.peerFingerprint,
      args.idempotencyKey,
    );
    if (existing) return existing;

    const task: A2aTask = {
      id: newTaskId(),
      status: 'submitted',
      createdAt: this.now(),
      idempotencyKey: args.idempotencyKey,
      traceId: args.traceId,
      peerFingerprint: args.peerFingerprint,
      // Stamp the owning personality so the SSE stream can reject a cross-
      // personality read (plan §15 multi-tenancy task-ownership check).
      personalityId: args.personalityId,
    };
    await this.opts.taskStore.create(task);
    this.running.set(task.id, this.execute(task, args));
    return task;
  }

  /** The background settle promise for a task (undefined once forgotten). */
  settled(taskId: string): Promise<A2aTask> | undefined {
    return this.running.get(taskId);
  }

  /** Fail-open, metadata-only task-state audit — never a message body (plan §13). */
  private auditStatus(task: A2aTask, args: SubmitAsyncArgs, status: A2aTask['status']): void {
    safeAudit(this.opts.auditSink, {
      kind: 'task',
      event: 'task-state',
      personalityId: args.personalityId,
      peerFingerprint: args.peerFingerprint,
      taskId: task.id,
      traceId: task.traceId,
      status,
      decision: 'accepted',
      severity: status === 'failed' ? 'error' : 'info',
      ts: this.now(),
    });
  }

  private async execute(task: A2aTask, args: SubmitAsyncArgs): Promise<A2aTask> {
    const store = this.opts.taskStore;
    try {
      await store.update(task.id, { status: 'working' });
      this.auditStatus(task, args, 'working');
      const { text, error } = await collectAgentRun(
        this.opts.runner.run(args.personalityId, args.message, {
          sessionKey: args.sessionKey,
          skill: args.skill,
          delegation: { traceId: args.traceId, depth: args.depth },
        }),
      );
      if (error !== undefined) {
        this.auditStatus(task, args, 'failed');
        return await this.finalize(task, { status: 'failed', error });
      }
      await store.update(task.id, { status: 'completed', result: text });
      this.auditStatus(task, args, 'completed');
      return await this.finalize(task, { status: 'completed', result: text });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.auditStatus(task, args, 'failed');
      return await this.finalize(task, { status: 'failed', error: message });
    }
  }

  private async finalize(task: A2aTask, patch: Partial<A2aTask>): Promise<A2aTask> {
    const updated = (await this.opts.taskStore.update(task.id, patch)) ?? { ...task, ...patch };
    this.running.delete(task.id);
    this.opts.onSettled?.(task.traceId);
    return updated;
  }
}

/** Re-export so callers can branch on terminal state without a second import. */
export { isTerminalStatus };
