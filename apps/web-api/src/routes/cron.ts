import { Hono } from 'hono';
import { type ApiKeyAuthStore, bearerAuth } from '../middleware/bearer-auth';

// External cron trigger (plan/phases/cron-scheduler-seam.md). `POST
// /cron/fire` calls straight into the configured `HttpFireTrigger.fire()` —
// the same due-scan/claim/execute cycle the local interval trigger runs.
// Cookie auth cannot reach this route at all; it's a machine-to-machine
// surface (an external scheduler, or an operator's own `curl`/cron rehearsing
// the hybrid-dev-mode wake path), gated by a bearer key carrying the `cron`
// scope. Mounted whenever the host app wires a trigger (see
// apps/web-api/src/routes/index.ts) — and `ethos serve` / `ethos boot` now
// always do.
//
// No config gates this route any more, so the `cron` scope check is its SOLE
// gate. That is deliberate: the route takes no input and returns no data, its
// whole body is the due-scan the local interval already runs every 60s,
// `claimDueJob` prevents double execution, and it is bearer-only — cookie and
// session auth cannot reach it, so browser XSS/CSRF cannot either. A
// deployment that mints no `cron`-scoped key gets a permanent 401. The cost,
// stated plainly: "unreachable because unmounted" was a defence-in-depth
// layer, and it is gone — "unreachable because unauthorized" is what is left.

export interface CronFireTrigger {
  fire(): Promise<void>;
}

export interface CronRouteOptions {
  apiKeys: ApiKeyAuthStore;
  trigger: CronFireTrigger;
}

export function cronRoutes(opts: CronRouteOptions) {
  const app = new Hono();

  app.post('/fire', bearerAuth({ store: opts.apiKeys, scope: 'cron' }), async (c) => {
    await opts.trigger.fire();
    return c.json({ ok: true });
  });

  return app;
}
