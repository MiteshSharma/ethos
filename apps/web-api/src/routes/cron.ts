import { Hono } from 'hono';
import { type ApiKeyAuthStore, bearerAuth } from '../middleware/bearer-auth';

// External cron trigger (plan/phases/cron-scheduler-seam.md). `POST
// /cron/fire` calls straight into the configured `HttpFireTrigger.fire()` —
// the same due-scan/claim/execute cycle the local interval trigger runs.
// Cookie auth cannot reach this route at all; it's a machine-to-machine
// surface (an external scheduler, or an operator's own `curl`/cron rehearsing
// the hybrid-dev-mode wake path), gated by a bearer key carrying the `cron`
// scope. Mounted only when boot code wires a trigger (see
// apps/web-api/src/routes/index.ts and apps/ethos/src/commands/serve.ts) —
// i.e. only when `cron.trigger.external` is `true`.

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
