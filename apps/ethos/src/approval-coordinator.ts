import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { BeforeToolCallPayload, BeforeToolCallResult } from '@ethosagent/types';

// In-process state machine for tool approvals in the gateway profile —
// the channel-adapter analogue of web-api's `ApprovalsService`. It bridges
// the agent loop's synchronous `before_tool_call` hook (an awaited Promise)
// with the user's asynchronous decision arriving as a Slack button click.
//
//   loop                    ApprovalCoordinator            Slack
//   ----                    -------------------            -----
//   hook fires ─ requestApproval ──► register pending,
//                                    emit('pending')   ──► post approval card
//                                                          user clicks button
//   hook awaits ◄──────── promise ◄── approve()/deny() ◄── action handler
//
// The Promise stored in `pending` is the only thread of control that
// remembers "the agent is paused on this tool call." Resolving it lets the
// loop continue; a deny translates into a `{ error }` returned from the hook,
// which the loop renders as a tool_result with is_error=true.
//
// This module is platform-agnostic by construction — it never imports the
// Slack adapter. The gateway command wires the glue: `onPending` → post a
// card, the adapter's button-click event → `approve()` / `deny()`.

export type ApprovalDecision = { decision: 'allow' } | { decision: 'deny'; reason: string };

/** A pending approval surfaced to the `onPending` subscriber. */
export interface PendingApproval {
  approvalId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  /** Human-readable cause from the danger predicate, or null. */
  reason: string | null;
  /**
   * Platform user id of whoever's message triggered this turn. When set,
   * only that user (or a `'system'` resolution — timeout / session cancel)
   * may resolve the approval: a dangerous tool call must not be approvable
   * by an arbitrary bystander who can see the card. Unset means no binding —
   * any decider is accepted (used where the surface has only one user, e.g.
   * a DM, or where the caller opts out).
   */
  requesterUserId?: string;
}

export interface RequestApprovalInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  reason: string | null;
  /** See `PendingApproval.requesterUserId`. */
  requesterUserId?: string;
}

/** Decider id used for non-user resolutions (timeout, session cancel). It is
 *  the one value that bypasses the `requesterUserId` binding check. */
const SYSTEM_DECIDER = '__ethos_system__';

interface PendingEntry {
  resolve: (d: ApprovalDecision) => void;
  request: PendingApproval;
  /** Auto-deny timer — cleared the moment any decision lands. Absent when
   *  the timeout is disabled (`timeoutMs <= 0`). */
  timer?: NodeJS.Timeout;
}

interface CoordinatorEventMap {
  pending: [PendingApproval];
  resolved: [approvalId: string, decision: 'allow' | 'deny', decidedBy: string];
}

export interface ApprovalCoordinatorOptions {
  /**
   * Auto-deny a pending approval after this many ms. The backstop for a lost
   * button click, a deleted card, or any integration failure that would
   * otherwise leave the agent loop's hook suspended forever. Defaults to 10
   * minutes; pass `0` to disable (tests, trusted-local automation).
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class ApprovalCoordinator {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly emitter = new EventEmitter<CoordinatorEventMap>();
  private readonly timeoutMs: number;

  constructor(opts: ApprovalCoordinatorOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Glue may attach several listeners (card poster + observability); the
    // default cap of 10 is plenty but we silence the warning to be safe.
    this.emitter.setMaxListeners(0);
  }

  /**
   * Hook side. Returns a Promise that resolves once `approve` / `deny` is
   * called for the emitted `approvalId`.
   */
  requestApproval(req: RequestApprovalInput): Promise<ApprovalDecision> {
    const approvalId = randomUUID();
    return new Promise<ApprovalDecision>((resolve) => {
      const request: PendingApproval = {
        approvalId,
        sessionId: req.sessionId,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        args: req.args,
        reason: req.reason,
        requesterUserId: req.requesterUserId,
      };
      let timer: NodeJS.Timeout | undefined;
      if (this.timeoutMs > 0) {
        timer = setTimeout(() => {
          this.settle(
            approvalId,
            { decision: 'deny', reason: 'approval timed out' },
            SYSTEM_DECIDER,
          );
        }, this.timeoutMs);
        // Don't keep the process alive solely for a pending approval.
        timer.unref?.();
      }
      this.pending.set(approvalId, { resolve, request, timer });
      this.emitter.emit('pending', request);
    });
  }

  /** Resolve a pending approval as allowed. Idempotent — a decision for an
   *  already-resolved (or unknown) approvalId is a silent no-op, so a stale
   *  button click from a second surface never throws or flips the result. */
  async approve(approvalId: string, decidedBy: string): Promise<void> {
    this.settle(approvalId, { decision: 'allow' }, decidedBy);
  }

  /** Resolve a pending approval as denied. Idempotent (see `approve`). */
  async deny(approvalId: string, decidedBy: string): Promise<void> {
    this.settle(approvalId, { decision: 'deny', reason: 'denied by user' }, decidedBy);
  }

  /**
   * Drop every pending approval for a session — called when the session is
   * forgotten so the agent loop unblocks instead of waiting forever for a
   * decision that will never come.
   */
  cancelForSession(sessionId: string, reason = 'session ended'): void {
    for (const [approvalId, entry] of this.pending.entries()) {
      if (entry.request.sessionId !== sessionId) continue;
      this.settle(approvalId, { decision: 'deny', reason }, SYSTEM_DECIDER);
    }
  }

  /**
   * The single resolution path — every decision (button click, timeout,
   * session cancel) funnels through here. Idempotent: an unknown or
   * already-resolved approvalId is a no-op, which is what makes a stale
   * click or a timeout-after-decision harmless. Clears the auto-deny timer
   * so a resolved approval never double-fires.
   *
   * Enforces the requester binding: when the pending approval carries a
   * `requesterUserId`, only that user — or a `SYSTEM_DECIDER` resolution —
   * may settle it. A bystander's click is dropped, leaving the approval
   * pending for the rightful decider (or the timeout backstop).
   */
  private settle(approvalId: string, decision: ApprovalDecision, decidedBy: string): void {
    const entry = this.pending.get(approvalId);
    if (!entry) return;
    const requester = entry.request.requesterUserId;
    if (requester !== undefined && decidedBy !== SYSTEM_DECIDER && decidedBy !== requester) {
      return;
    }
    this.pending.delete(approvalId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(decision);
    this.emitter.emit('resolved', approvalId, decision.decision, decidedBy);
  }

  /** Visible for tests + internal observability. */
  pendingCount(): number {
    return this.pending.size;
  }

  onPending(handler: (request: PendingApproval) => void): () => void {
    this.emitter.on('pending', handler);
    return () => {
      this.emitter.off('pending', handler);
    };
  }

  onResolved(
    handler: (approvalId: string, decision: 'allow' | 'deny', decidedBy: string) => void,
  ): () => void {
    this.emitter.on('resolved', handler);
    return () => {
      this.emitter.off('resolved', handler);
    };
  }
}

/** Result returned by a danger predicate. `null` = no approval needed. */
export type DangerReason = string | null;
export type DangerPredicate = (payload: BeforeToolCallPayload) => Promise<DangerReason>;

/** Where a turn's Slack approval prompt would go. `requesterUserId` binds
 *  the approval to the user who triggered the turn. */
export interface ApprovalTarget {
  /** Platform user id of whoever triggered the turn — only they (or a
   *  system resolution) may resolve the approval. */
  requesterUserId?: string;
}

export interface CreateSlackApprovalHookOptions {
  coordinator: ApprovalCoordinator;
  isDangerous: DangerPredicate;
  /**
   * Resolves the `sessionId` to its Slack approval target, or `undefined`
   * when the turn has no Slack approval surface at all.
   *
   * This is what keeps the hook from coupling Slack to other platforms: the
   * same `AgentLoop` can be shared by a Slack adapter AND a non-Slack one
   * (e.g. a Discord/Email message that fell back to a Slack-bound bot's
   * loop). For those non-Slack turns this returns `undefined` and the hook
   * passes the call straight through — it does NOT suspend or deny — so the
   * loop's other guards (the synchronous terminal hard-block) decide.
   * Adding Slack to a bot must not silently change tool behavior on its
   * other channels.
   *
   * `before_tool_call` carries only `sessionId`; the gateway is the
   * component that knows both the originating platform and user.
   */
  resolveApprovalTarget: (sessionId: string) => ApprovalTarget | undefined;
}

/**
 * `before_tool_call` hook handler for the gateway/Slack profile. Mirrors
 * web-api's `createWebApprovalHook`: a non-dangerous call passes straight
 * through; a dangerous one is registered with the coordinator and the hook
 * suspends on the returned Promise until the user clicks Allow / Deny.
 *
 * The danger predicate is injected so this file stays free of any extension
 * imports — see `@ethosagent/wiring`'s `createDangerPredicate`.
 */
export function createSlackApprovalHook(opts: CreateSlackApprovalHookOptions) {
  return async (payload: BeforeToolCallPayload): Promise<Partial<BeforeToolCallResult> | null> => {
    const reason = await opts.isDangerous(payload);
    if (reason === null) return null;

    // No Slack approval surface for this turn (a non-Slack channel sharing
    // the loop) — pass through untouched. Suspending or denying here would
    // be hidden cross-platform coupling.
    const target = opts.resolveApprovalTarget(payload.sessionId);
    if (target === undefined) return null;

    const decision = await opts.coordinator.requestApproval({
      sessionId: payload.sessionId,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      args: payload.args,
      reason,
      requesterUserId: target.requesterUserId,
    });

    if (decision.decision === 'allow') return null;
    return { error: decision.reason };
  };
}
