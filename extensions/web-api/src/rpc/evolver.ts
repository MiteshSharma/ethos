import { os } from './context';

// Thin RPC shells for the evolver namespace. Mutations on the approval
// queue go through this namespace (not skills) — see the plan's
// "Skills" tab description: Library + Evolver are two panels backed by
// two namespaces.

export const evolverRouter = {
  configGet: os.evolver.configGet.handler(({ context }) => context.evolver.getConfig()),

  configUpdate: os.evolver.configUpdate.handler(({ input, context }) =>
    context.evolver.updateConfig(input),
  ),

  pendingList: os.evolver.pendingList.handler(({ context }) => context.evolver.listPending()),

  pendingApprove: os.evolver.pendingApprove.handler(async ({ input, context }) => {
    await context.evolver.approvePending(input.id);
    return { ok: true as const };
  }),

  pendingReject: os.evolver.pendingReject.handler(async ({ input, context }) => {
    await context.evolver.rejectPending(input.id);
    return { ok: true as const };
  }),

  history: os.evolver.history.handler(({ input, context }) =>
    context.evolver.listHistory(input.limit),
  ),
};
