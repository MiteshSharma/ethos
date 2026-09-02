import { os } from './context';

// Full-vault key inventory. `list` returns masked previews only — a raw value
// never comes back. Reflected named secrets are read-only here; the service
// rejects `set`/`clear` on them.

export const keysRouter = {
  list: os.keys.list.handler(({ context }) => context.keys.list()),

  set: os.keys.set.handler(({ input, context }) => context.keys.set(input)),

  clear: os.keys.clear.handler(({ input, context }) => context.keys.clear(input)),
};
