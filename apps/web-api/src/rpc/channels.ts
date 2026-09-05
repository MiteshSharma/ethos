import { os } from './context';

// Channels namespace — read-only view of the rooms a bot observes but never
// answers (plan/phases/ambient-group-monitoring.md R12).
//
// No `requireAdmin`, for the same reason `deliveries` and `voice.calls` have
// none: that gate belongs to the admin PANEL (`admin.enabled`, default false),
// while everything else that reads deployment state is guarded by the `/rpc`
// cookie/bearer auth alone.
//
// The service never throws — an unreadable transcript comes back as `error`,
// which the Communications page draws as a `✗ failed` row that stays.

export const channelsRouter = {
  observed: os.channels.observed.handler(({ input, context }) =>
    context.observedChats.observed(input),
  ),
};
