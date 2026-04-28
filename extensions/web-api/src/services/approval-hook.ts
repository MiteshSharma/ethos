import type { BeforeToolCallPayload, BeforeToolCallResult } from '@ethosagent/types';
import type { ApprovalsService } from './approvals.service';

// `before_tool_call` hook handler used by the web profile. Replaces the
// blunt CLI/TUI guard hook (`createTerminalGuardHook` from `tools-terminal`)
// — instead of returning a hard `{ error }` for dangerous commands, this
// hook consults the user via the SSE approval flow and proceeds based on
// their decision.
//
// The danger predicate is injected so this file stays free of any
// extension imports. See `@ethosagent/wiring`'s `createDangerPredicate` for
// the default rules (terminal `checkCommand` + always-ask list).

export type DangerReason = string | null;
export type DangerPredicate = (payload: BeforeToolCallPayload) => DangerReason;

export interface CreateApprovalHookOptions {
  approvals: ApprovalsService;
  isDangerous: DangerPredicate;
}

export function createWebApprovalHook(opts: CreateApprovalHookOptions) {
  return async (payload: BeforeToolCallPayload): Promise<Partial<BeforeToolCallResult> | null> => {
    const reason = opts.isDangerous(payload);
    if (reason === null) return null;

    const decision = await opts.approvals.requestApproval({
      sessionId: payload.sessionId,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      args: payload.args,
      reason,
    });

    if (decision.decision === 'allow') return null;
    return { error: decision.reason };
  };
}
