import { os } from './context';

// Calls sub-namespace of `voice` — read-only view of the telephony call log.
//
// Mounted under `voice` rather than at the top level: a call is the phone
// surface of the voice stack, and the Settings/Communications UI reads it
// alongside `voice.satellites` and `voice.wakeRoutes`.
//
// No `requireAdmin`, for the same reason `deliveries` has none — that gate
// belongs to the admin PANEL (`admin.enabled`, default false), while everything
// else that reads deployment state is guarded by the `/rpc` cookie/bearer auth
// alone.
//
// The service is OPTIONAL in context: a deployment with no telephony has no call
// log, and the handlers then report an empty house rather than throwing at a UI
// that legitimately has nothing to show.

export const callsRouter = {
  list: os.voice.calls.list.handler(async ({ input, context }) => ({
    calls: (await context.calls?.list(input)) ?? [],
  })),
  active: os.voice.calls.active.handler(async ({ context }) => ({
    calls: (await context.calls?.active()) ?? [],
  })),
  get: os.voice.calls.get.handler(async ({ input, context }) => ({
    call: (await context.calls?.get(input.id)) ?? null,
  })),
};
