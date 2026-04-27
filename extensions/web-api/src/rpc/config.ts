import { os } from './context';

// Config namespace — read returns redacted apiKey preview; update accepts a
// fresh key but doesn't echo it. Service-layer enforces redaction so the
// raw key never exits the host process via this surface.

export const configRouter = {
  get: os.config.get.handler(({ context }) => context.config.get()),

  update: os.config.update.handler(async ({ input, context }) => {
    await context.config.update(input);
    return { ok: true as const };
  }),
};
