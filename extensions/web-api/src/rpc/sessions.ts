import { os } from './context';

// Thin RPC shells. Each handler validates input via the contract (free),
// calls one service method, returns its result. No FS access, no SQL, no
// extension imports. The layering CI lint test enforces this.

export const sessionsRouter = {
  list: os.sessions.list.handler(({ input, context }) =>
    context.sessions.list({
      ...(input.q !== undefined ? { q: input.q } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      ...(input.personalityId ? { personalityId: input.personalityId } : {}),
    }),
  ),

  get: os.sessions.get.handler(({ input, context }) => context.sessions.get(input.id)),

  fork: os.sessions.fork.handler(({ input, context }) =>
    context.sessions.fork(input.id, input.personalityId),
  ),

  delete: os.sessions.delete.handler(async ({ input, context }) => {
    await context.sessions.delete(input.id);
    return { ok: true as const };
  }),
};
