import { os } from './context';

// Thin RPC shells for the tools namespace. Both procedures resolve a
// pending approval registered by the web `before_tool_call` hook; the
// actual state machine + allowlist work lives in `ApprovalsService`.
//
// `clientId` flows in as `decidedBy` on the resulting `approval.resolved`
// SSE event so other tabs viewing the same session can auto-dismiss the
// modal with "approved by another window."

export const toolsRouter = {
  approve: os.tools.approve.handler(async ({ input, context }) => {
    await context.approvals.approve(input.approvalId, input.scope, input.clientId);
    return { ok: true as const };
  }),

  deny: os.tools.deny.handler(async ({ input, context }) => {
    await context.approvals.deny(input.approvalId, input.reason, input.clientId);
    return { ok: true as const };
  }),
};
