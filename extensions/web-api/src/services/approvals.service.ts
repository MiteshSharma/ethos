import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { EthosError } from '@ethosagent/types';
import type { ApprovalRequest, ApprovalScope } from '@ethosagent/web-contracts';
import type { AllowlistRepository } from '../repositories/allowlist.repository';

// In-process state machine for tool approvals. Bridges the agent loop's
// synchronous `before_tool_call` hook (an awaited Promise) with the user's
// asynchronous decision arriving as a separate HTTP request hours later.
//
//   loop                       ApprovalsService                client tab
//   ----                       ----------------                ----------
//   hook fires ── requestApproval ─────► register pending,
//                                        emit('pending')   ──► SSE event
//                                                              user clicks
//   hook awaits ◄────────── promise ◄── approve()/deny() ◄── /rpc/tools/*
//
// The Promise stored in `pending` is the only thread of control that remembers
// "the agent is paused on this tool call." Resolving it lets the loop continue;
// rejecting (deny) translates into a `{ error }` returned from the hook,
// which the loop renders as a tool_result with is_error=true.

export interface ApprovalRequestInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  /** Human-readable cause — e.g. "recursive force-delete of root directory". */
  reason?: string;
}

export type ApprovalDecision = { decision: 'allow' } | { decision: 'deny'; reason: string };

interface PendingApproval {
  resolve: (d: ApprovalDecision) => void;
  request: ApprovalRequestInput;
}

interface ApprovalEventMap {
  pending: [sessionId: string, request: ApprovalRequest];
  resolved: [sessionId: string, approvalId: string, decision: 'allow' | 'deny', decidedBy: string];
}

export interface ApprovalsServiceOptions {
  allowlist: AllowlistRepository;
}

export class ApprovalsService {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly emitter = new EventEmitter<ApprovalEventMap>();

  constructor(private readonly opts: ApprovalsServiceOptions) {
    // Many SSE subscribers per session — no warning at 10.
    this.emitter.setMaxListeners(0);
  }

  /**
   * Hook side. Returns a Promise that resolves once the user (or another
   * tab) calls `approve` or `deny`. Allowlist hits short-circuit to
   * `{ decision: 'allow' }` without any user interaction.
   */
  async requestApproval(req: ApprovalRequestInput): Promise<ApprovalDecision> {
    if (await this.opts.allowlist.matches(req.toolName, req.args)) {
      return { decision: 'allow' };
    }
    const approvalId = randomUUID();
    return new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(approvalId, { resolve, request: req });
      const wireRequest: ApprovalRequest = {
        approvalId,
        sessionId: req.sessionId,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        args: req.args,
        reason: req.reason ?? null,
      };
      this.emitter.emit('pending', req.sessionId, wireRequest);
    });
  }

  /**
   * Resolve a pending approval as allowed. When `scope` is `exact-args` or
   * `any-args` the decision is persisted to the allowlist so future identical
   * calls auto-allow. `once` is in-memory only.
   */
  async approve(approvalId: string, scope: ApprovalScope, decidedBy: string): Promise<void> {
    const p = this.take(approvalId);
    if (scope !== 'once') {
      await this.opts.allowlist.add({
        toolName: p.request.toolName,
        scope,
        args: scope === 'exact-args' ? p.request.args : null,
      });
    }
    p.resolve({ decision: 'allow' });
    this.emitter.emit('resolved', p.request.sessionId, approvalId, 'allow', decidedBy);
  }

  async deny(approvalId: string, reason: string | undefined, decidedBy: string): Promise<void> {
    const p = this.take(approvalId);
    p.resolve({ decision: 'deny', reason: reason ?? 'denied by user' });
    this.emitter.emit('resolved', p.request.sessionId, approvalId, 'deny', decidedBy);
  }

  /**
   * Drop every pending approval for a session — called when the session is
   * forgotten so the agent loop unblocks instead of waiting forever for a
   * decision that will never come.
   */
  cancelForSession(sessionId: string, reason = 'session ended'): void {
    for (const [approvalId, p] of this.pending.entries()) {
      if (p.request.sessionId !== sessionId) continue;
      this.pending.delete(approvalId);
      p.resolve({ decision: 'deny', reason });
    }
  }

  /** Visible for tests + internal observability. */
  pendingCount(): number {
    return this.pending.size;
  }

  onPending(handler: (sessionId: string, request: ApprovalRequest) => void): () => void {
    this.emitter.on('pending', handler);
    return () => {
      this.emitter.off('pending', handler);
    };
  }

  onResolved(
    handler: (
      sessionId: string,
      approvalId: string,
      decision: 'allow' | 'deny',
      decidedBy: string,
    ) => void,
  ): () => void {
    this.emitter.on('resolved', handler);
    return () => {
      this.emitter.off('resolved', handler);
    };
  }

  private take(approvalId: string): PendingApproval {
    const p = this.pending.get(approvalId);
    if (!p) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `No pending approval for id ${approvalId}`,
        action:
          'The approval was already resolved (likely by another tab) or the agent moved on. Reload to see the current state.',
      });
    }
    this.pending.delete(approvalId);
    return p;
  }
}
