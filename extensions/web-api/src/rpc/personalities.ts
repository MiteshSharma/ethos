import { os } from './context';

// Read-only personalities namespace. v0 lists + opens; create / edit /
// per-personality skills come in v1 (26.4b).

export const personalitiesRouter = {
  list: os.personalities.list.handler(({ context }) => context.personalities.list()),

  get: os.personalities.get.handler(({ input, context }) => context.personalities.get(input.id)),
};
