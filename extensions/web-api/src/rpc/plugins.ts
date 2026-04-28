import { os } from './context';

// Thin RPC shell for the plugins namespace.

export const pluginsRouter = {
  list: os.plugins.list.handler(({ context }) => context.plugins.list()),
};
