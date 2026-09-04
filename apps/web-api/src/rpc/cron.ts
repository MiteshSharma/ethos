import { EthosError } from '@ethosagent/types';
import type { CronDeliverTo } from '@ethosagent/web-contracts';
import { os } from './context';

// Thin RPC shells for the cron namespace. Every handler is a single
// service call — no FS, no scheduler logic in here. Per the layered
// architecture rule, RPC handlers stay ≤10 lines each.

/**
 * Refusal rule 4 of plan/phases/recipes-gallery.md §1: a bearer API key minted
 * for an external Mission Control must not be able to point an agent's output
 * at a chat. In-app and file-only delivery stay reachable over bearer auth.
 *
 * This lives HERE and not in `SCOPE_MAP` (Open Question 3) because that map is
 * keyed `namespace.method → one scope`; it has no per-field granularity, so it
 * can only say "all of `cron.create` is cookie-only", which would also revoke
 * the two harmless arms. (Today the `cron` namespace is unmapped, so `dualAuth`
 * already fails bearer closed for every `cron.*` method — this guard is what
 * keeps rule 4 true if that ever changes.)
 */
function assertChannelDeliveryAllowed(context: object, deliverTo: CronDeliverTo | undefined): void {
  if (deliverTo?.kind !== 'channel') return;
  const method: unknown = (context as { _authMethod?: unknown })._authMethod;
  if (method !== 'bearer') return;
  throw new EthosError({
    code: 'FORBIDDEN',
    cause: 'Delivering a cron job into a chat requires cookie authentication.',
    action: 'Create channel-delivering jobs from the Ethos web UI.',
  });
}

export const cronRouter = {
  list: os.cron.list.handler(({ context }) => context.cron.list()),

  get: os.cron.get.handler(({ input, context }) => context.cron.get(input.id)),

  create: os.cron.create.handler(({ input, context }) => {
    assertChannelDeliveryAllowed(context, input.deliverTo);
    return context.cron.create({
      name: input.name,
      schedule: input.schedule,
      prompt: input.prompt,
      personalityId: input.personalityId,
      ...(input.missedRunPolicy !== undefined && { missedRunPolicy: input.missedRunPolicy }),
      ...(input.notifyInApp !== undefined && { notifyInApp: input.notifyInApp }),
      ...(input.deliverTo !== undefined && { deliverTo: input.deliverTo }),
    });
  }),

  update: os.cron.update.handler(({ input, context }) =>
    context.cron.update(input.id, {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.schedule !== undefined && { schedule: input.schedule }),
      ...(input.prompt !== undefined && { prompt: input.prompt }),
    }),
  ),

  delete: os.cron.delete.handler(async ({ input, context }) => {
    await context.cron.delete(input.id);
    return { ok: true as const };
  }),

  pause: os.cron.pause.handler(async ({ input, context }) => {
    await context.cron.pause(input.id);
    return { ok: true as const };
  }),

  resume: os.cron.resume.handler(async ({ input, context }) => {
    await context.cron.resume(input.id);
    return { ok: true as const };
  }),

  runNow: os.cron.runNow.handler(async ({ input, context }) => {
    const result = await context.cron.runNow(input.id);
    return { ok: true as const, output: result.output, ranAt: result.ranAt };
  }),

  history: os.cron.history.handler(({ input, context }) =>
    context.cron.history(input.id, input.limit),
  ),

  deliveryTargets: os.cron.deliveryTargets.handler(({ input, context }) =>
    context.cron.deliveryTargets(input.personalityId),
  ),
};
