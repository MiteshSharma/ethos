import type { CronScheduler, CronJob as ExtCronJob } from '@ethosagent/cron';
import { isEthosError } from '@ethosagent/types';
import { call } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';
import { cronRouter } from '../../rpc/cron';
import { CronService } from '../../services/cron.service';
import {
  type DeliveryBot,
  type DeliveryTargetWorld,
  resolveDeliveryTargets,
} from '../../services/cron-delivery-targets';

// Channel-addressable cron delivery — plan/phases/recipes-gallery.md §1.
//
// The four refusal rules are the point of this change, so each gets its own
// case. Pointing an agent's scheduled output at a chat is a NEW capability:
// until now, only a message sent from inside that chat could aim a job at it,
// and the originating-session rule was itself the authorization.

const TELEGRAM_BOT: DeliveryBot = {
  platform: 'telegram',
  botKey: 'bot-a',
  botLabel: '@briefer_bot',
  bind: { type: 'personality', name: 'briefer' },
};

const OTHER_BOT: DeliveryBot = {
  platform: 'telegram',
  botKey: 'bot-b',
  botLabel: '@other_bot',
  bind: { type: 'personality', name: 'archivist' },
};

interface WorldOverrides {
  bots?: DeliveryBot[];
  teams?: Record<string, string[]>;
  filters?: Record<string, { enabled: boolean; ownerUserId: string; allowlist: string[] }>;
  paired?: Record<string, string[]>;
  observed?: Record<string, string[]>;
}

/** A world with nothing in it but what a case puts there. */
function makeWorld(o: WorldOverrides = {}): DeliveryTargetWorld {
  return {
    listBots: async () => o.bots ?? [TELEGRAM_BOT],
    teamMembers: async (team) => o.teams?.[team] ?? [],
    // Absent block: the repository collapses it to enabled-with-nothing-declared.
    channelFilter: async (platform) =>
      o.filters?.[platform] ?? { enabled: true, ownerUserId: '', allowlist: [] },
    approvedSenders: async (platform) => o.paired?.[platform] ?? [],
    observedChatIds: async (platform, botKey) => o.observed?.[`${platform}:${botKey}`] ?? [],
  };
}

function makeScheduler(): { scheduler: CronScheduler; createJob: ReturnType<typeof vi.fn> } {
  const createJob = vi.fn(
    async (input: Partial<ExtCronJob>): Promise<ExtCronJob> =>
      ({
        id: 'job-1',
        name: input.name ?? '',
        schedule: input.schedule ?? '',
        prompt: input.prompt ?? '',
        personalityId: input.personalityId ?? '',
        status: 'active',
        missedRunPolicy: input.missedRunPolicy ?? 'skip',
        createdAt: new Date().toISOString(),
        ...(input.origin ? { origin: input.origin } : {}),
      }) as ExtCronJob,
  );
  return { scheduler: { createJob } as unknown as CronScheduler, createJob };
}

const BASE = { name: 'briefing', schedule: '20 6 * * *', prompt: 'go', personalityId: 'briefer' };

async function expectRefusal(promise: Promise<unknown>, code: string): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!isEthosError(err)) throw new Error(`expected an EthosError, got ${String(err)}`);
  expect(err.code).toBe(code);
  return err.cause;
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

describe('resolveDeliveryTargets', () => {
  it('offers only bots whose bind speaks for the personality (rule 1)', async () => {
    const world = makeWorld({
      bots: [TELEGRAM_BOT, OTHER_BOT],
      observed: { 'telegram:bot-a': ['111'], 'telegram:bot-b': ['222'] },
    });
    const { bots, targets } = await resolveDeliveryTargets(world, 'briefer');
    expect(bots.map((b) => b.botKey)).toEqual(['bot-a']);
    expect(targets.map((t) => t.chatId)).toEqual(['111']);
  });

  it('resolves a team bind through the team it names', async () => {
    const world = makeWorld({
      bots: [{ ...TELEGRAM_BOT, bind: { type: 'team', name: 'newsroom' } }],
      teams: { newsroom: ['briefer', 'archivist'] },
      observed: { 'telegram:bot-a': ['111'] },
    });
    await expect(resolveDeliveryTargets(world, 'briefer')).resolves.toMatchObject({
      targets: [expect.objectContaining({ chatId: '111', source: 'observed' })],
    });
    await expect(resolveDeliveryTargets(world, 'stranger')).resolves.toMatchObject({
      bots: [],
      targets: [],
    });
  });

  it('unions owner, allowlist, paired and observed when a filter is declared', async () => {
    const world = makeWorld({
      filters: { telegram: { enabled: true, ownerUserId: '900', allowlist: ['901'] } },
      paired: { telegram: ['902'] },
      observed: { 'telegram:bot-a': ['903'] },
    });
    const { targets } = await resolveDeliveryTargets(world, 'briefer');
    expect(targets.map((t) => [t.chatId, t.source])).toEqual([
      ['900', 'owner'],
      ['901', 'allowlist'],
      ['902', 'paired'],
      ['903', 'observed'],
    ]);
    expect(targets[0]?.botLabel).toBe('@briefer_bot');
  });

  it('keeps the highest-priority source when one chat appears twice', async () => {
    const world = makeWorld({
      filters: { telegram: { enabled: true, ownerUserId: '900', allowlist: [] } },
      observed: { 'telegram:bot-a': ['900'] },
    });
    const { targets } = await resolveDeliveryTargets(world, 'briefer');
    expect(targets).toHaveLength(1);
    expect(targets[0]?.source).toBe('owner');
  });

  // Rule 3.
  it('falls back to observed-only when the platform has no channel filter', async () => {
    const world = makeWorld({
      paired: { telegram: ['902'] },
      observed: { 'telegram:bot-a': ['903'] },
    });
    const { targets } = await resolveDeliveryTargets(world, 'briefer');
    expect(targets.map((t) => [t.chatId, t.source])).toEqual([['903', 'observed']]);
  });

  // Rule 3, the other half: a filter that is present but switched off is the
  // back-compat "allow all inbound" mode, which is not a licence to originate.
  it('falls back to observed-only when the channel filter is disabled', async () => {
    const world = makeWorld({
      filters: { telegram: { enabled: false, ownerUserId: '900', allowlist: ['901'] } },
      paired: { telegram: ['902'] },
      observed: { 'telegram:bot-a': ['903'] },
    });
    const { targets } = await resolveDeliveryTargets(world, 'briefer');
    expect(targets.map((t) => t.chatId)).toEqual(['903']);
  });
});

// ---------------------------------------------------------------------------
// CronService.create — the union, the alias, and rules 1 + 2
// ---------------------------------------------------------------------------

describe('CronService.create — deliverTo', () => {
  const world = makeWorld({
    filters: { telegram: { enabled: true, ownerUserId: '900', allowlist: [] } },
  });

  it('maps kind:channel onto an unchanged JobOrigin, dropping botKey', async () => {
    const { scheduler, createJob } = makeScheduler();
    const service = new CronService({ scheduler, deliveryWorld: world });
    await service.create({
      ...BASE,
      deliverTo: { kind: 'channel', platform: 'telegram', botKey: 'bot-a', chatId: '900' },
    });
    expect(createJob.mock.calls[0]?.[0].origin).toEqual({ platform: 'telegram', chatId: '900' });
  });

  it('maps kind:inApp onto the web heartbeat origin', async () => {
    const { scheduler, createJob } = makeScheduler();
    const service = new CronService({ scheduler, deliveryWorld: world });
    await service.create({ ...BASE, deliverTo: { kind: 'inApp' } });
    expect(createJob.mock.calls[0]?.[0].origin).toEqual({
      platform: 'web',
      chatId: 'web:heartbeat:briefer',
    });
  });

  it('maps kind:none onto no origin at all', async () => {
    const { scheduler, createJob } = makeScheduler();
    const service = new CronService({ scheduler, deliveryWorld: world });
    await service.create({ ...BASE, deliverTo: { kind: 'none' } });
    expect(createJob.mock.calls[0]?.[0].origin).toBeUndefined();
  });

  it('still honours the deprecated notifyInApp alias', async () => {
    const { scheduler, createJob } = makeScheduler();
    const service = new CronService({ scheduler, deliveryWorld: world });
    await service.create({ ...BASE, notifyInApp: true });
    expect(createJob.mock.calls[0]?.[0].origin).toEqual({
      platform: 'web',
      chatId: 'web:heartbeat:briefer',
    });
    await service.create({ ...BASE, notifyInApp: false });
    expect(createJob.mock.calls[1]?.[0].origin).toBeUndefined();
  });

  it('accepts notifyInApp and deliverTo together when they agree', async () => {
    const { scheduler, createJob } = makeScheduler();
    const service = new CronService({ scheduler, deliveryWorld: world });
    await service.create({ ...BASE, notifyInApp: true, deliverTo: { kind: 'inApp' } });
    await service.create({ ...BASE, notifyInApp: false, deliverTo: { kind: 'none' } });
    expect(createJob.mock.calls[0]?.[0].origin).toBeDefined();
    expect(createJob.mock.calls[1]?.[0].origin).toBeUndefined();
  });

  it('refuses notifyInApp and deliverTo when they disagree', async () => {
    const { scheduler, createJob } = makeScheduler();
    const service = new CronService({ scheduler, deliveryWorld: world });
    await expectRefusal(
      service.create({
        ...BASE,
        notifyInApp: true,
        deliverTo: { kind: 'channel', platform: 'telegram', botKey: 'bot-a', chatId: '900' },
      }),
      'INVALID_INPUT',
    );
    await expectRefusal(
      service.create({ ...BASE, notifyInApp: false, deliverTo: { kind: 'inApp' } }),
      'INVALID_INPUT',
    );
    expect(createJob).not.toHaveBeenCalled();
  });

  // Rule 1.
  it('refuses a bot that is not bound to the job personality', async () => {
    const { scheduler, createJob } = makeScheduler();
    const service = new CronService({
      scheduler,
      deliveryWorld: makeWorld({
        bots: [TELEGRAM_BOT, OTHER_BOT],
        filters: { telegram: { enabled: true, ownerUserId: '900', allowlist: [] } },
      }),
    });
    const cause = await expectRefusal(
      service.create({
        ...BASE,
        deliverTo: { kind: 'channel', platform: 'telegram', botKey: 'bot-b', chatId: '900' },
      }),
      'CRON_TARGET_NOT_ALLOWED',
    );
    expect(cause).toContain('bot-b');
    expect(createJob).not.toHaveBeenCalled();
  });

  // Rule 2 — the set is recomputed here, whatever the client previewed.
  it('refuses a client-supplied chatId outside the recomputed set', async () => {
    const { scheduler, createJob } = makeScheduler();
    const service = new CronService({ scheduler, deliveryWorld: world });
    await expectRefusal(
      service.create({
        ...BASE,
        deliverTo: { kind: 'channel', platform: 'telegram', botKey: 'bot-a', chatId: '666' },
      }),
      'CRON_TARGET_NOT_ALLOWED',
    );
    expect(createJob).not.toHaveBeenCalled();
  });

  it('refuses a chat the client could only have seen before the filter was switched off', async () => {
    // The picker offered `900` (owner). Between preview and create the operator
    // disabled the filter, so the server's recomputed set no longer has it.
    const { scheduler } = makeScheduler();
    const service = new CronService({
      scheduler,
      deliveryWorld: makeWorld({
        filters: { telegram: { enabled: false, ownerUserId: '900', allowlist: [] } },
      }),
    });
    await expectRefusal(
      service.create({
        ...BASE,
        deliverTo: { kind: 'channel', platform: 'telegram', botKey: 'bot-a', chatId: '900' },
      }),
      'CRON_TARGET_NOT_ALLOWED',
    );
  });

  it('refuses kind:channel where the deployment has no channel surface', async () => {
    const { scheduler } = makeScheduler();
    const service = new CronService({ scheduler });
    await expectRefusal(
      service.create({
        ...BASE,
        deliverTo: { kind: 'channel', platform: 'telegram', botKey: 'bot-a', chatId: '900' },
      }),
      'CRON_TARGET_NOT_ALLOWED',
    );
    await expect(service.deliveryTargets('briefer')).resolves.toEqual({ targets: [] });
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — cookie-auth only, in the handler
// ---------------------------------------------------------------------------

describe('cron.create handler — kind:channel is cookie-auth only (rule 4)', () => {
  // The handler declares an output schema, so a stubbed service still has to
  // hand back a job shaped like one.
  const WIRE_JOB = {
    job: {
      id: 'job-1',
      name: BASE.name,
      schedule: BASE.schedule,
      prompt: BASE.prompt,
      personalityId: BASE.personalityId,
      deliver: null,
      status: 'active' as const,
      missedRunPolicy: 'skip' as const,
      source: 'user' as const,
      systemTask: null,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: '2026-09-04T00:00:00.000Z',
    },
  };
  const channel = {
    kind: 'channel' as const,
    platform: 'telegram',
    botKey: 'bot-a',
    chatId: '900',
  };

  it('refuses kind:channel over bearer auth before the service is reached', async () => {
    const create = vi.fn();
    const context = { cron: { create }, _authMethod: 'bearer' } as never;
    await expectRefusal(
      call(cronRouter.create, { ...BASE, deliverTo: channel }, { context }),
      'FORBIDDEN',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('leaves the non-channel arms reachable over bearer auth', async () => {
    const create = vi.fn().mockResolvedValue(WIRE_JOB);
    const context = { cron: { create }, _authMethod: 'bearer' } as never;
    await call(cronRouter.create, { ...BASE, deliverTo: { kind: 'inApp' } }, { context });
    await call(cronRouter.create, { ...BASE, notifyInApp: true }, { context });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('allows kind:channel over cookie auth', async () => {
    const create = vi.fn().mockResolvedValue(WIRE_JOB);
    const context = { cron: { create }, _authMethod: 'cookie' } as never;
    await call(cronRouter.create, { ...BASE, deliverTo: channel }, { context });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ deliverTo: channel }));
  });

  it('treats an absent authMethod as cookie (no api-key store wired)', async () => {
    const create = vi.fn().mockResolvedValue(WIRE_JOB);
    const context = { cron: { create } } as never;
    await call(cronRouter.create, { ...BASE, deliverTo: channel }, { context });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
