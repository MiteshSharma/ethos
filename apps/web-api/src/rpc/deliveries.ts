import { os } from './context';

// Deliveries namespace — read-only view of the delivery-obligation ledger.
//
// No `requireAdmin`. That gate is specific to the admin PANEL (`admin.enabled`,
// default false) and is used by exactly one namespace, `admin`. Everything else
// that reads deployment state — `config.get` with its redacted credentials,
// `platforms.list`, `cron.list` — is guarded by the `/rpc` cookie/bearer auth
// alone, which already means "the operator". Putting the panel's opt-in gate in
// front of this one read would 403 the Settings page it exists to feed on every
// deployment that never enabled the panel.

export const deliveriesRouter = {
  summary: os.deliveries.summary.handler(({ input, context }) =>
    context.deliveries.summary(input.limit),
  ),
};
