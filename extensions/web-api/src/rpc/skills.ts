import { os } from './context';

// Thin RPC shells for the skills namespace. Every handler is a single
// service call — no FS, no parsing in here. Follows the layered rule
// (handlers ≤10 lines, business logic in the service).

export const skillsRouter = {
  list: os.skills.list.handler(({ context }) => context.skills.list()),

  get: os.skills.get.handler(({ input, context }) => context.skills.get(input.id)),

  create: os.skills.create.handler(({ input, context }) =>
    context.skills.create({ id: input.id, body: input.body }),
  ),

  update: os.skills.update.handler(({ input, context }) =>
    context.skills.update({ id: input.id, body: input.body }),
  ),

  delete: os.skills.delete.handler(async ({ input, context }) => {
    await context.skills.delete(input.id);
    return { ok: true as const };
  }),
};
