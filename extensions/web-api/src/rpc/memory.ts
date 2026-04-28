import { os } from './context';

// Thin RPC shells for the memory namespace.

export const memoryRouter = {
  list: os.memory.list.handler(({ context }) => context.memory.list()),

  get: os.memory.get.handler(({ input, context }) => context.memory.get(input.store)),

  write: os.memory.write.handler(({ input, context }) =>
    context.memory.write(input.store, input.content),
  ),
};
