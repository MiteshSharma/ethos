import { os } from './context';

// Thin RPC shells for the platforms namespace.

export const platformsRouter = {
  list: os.platforms.list.handler(({ context }) => context.platforms.list()),

  set: os.platforms.set.handler(({ input, context }) =>
    context.platforms.set(input.id, input.fields),
  ),

  clear: os.platforms.clear.handler(({ input, context }) => context.platforms.clear(input.id)),
};
