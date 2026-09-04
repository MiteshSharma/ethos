import type { CronScheduler, CronJob as ExtCronJob } from '@ethosagent/cron';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import { morningBriefing } from '@ethosagent/recipes';
import { SkillsLibrary } from '@ethosagent/skills';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { isEthosError, type Tool } from '@ethosagent/types';
import type { RecipeDiscoverChatsOutput } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { CronService } from '../../services/cron.service';
import {
  type DeliveryBot,
  type DeliveryTargetWorld,
  resolveDeliveryTargets,
} from '../../services/cron-delivery-targets';
import { createDiscoveredChatStore } from '../../services/discovered-chats';
import { PersonalitiesService } from '../../services/personalities.service';
import type { ChannelSetupWorld } from '../../services/recipe-channel-setup';
import { RecipesService, type RecipesServiceOptions } from '../../services/recipes.service';

// THE SCENARIO THE USER ACTUALLY HIT.
//
// "Deliver to — needed. No chat can receive this yet. Bind a bot to this agent
// in Communications, then re-check." It could never be satisfied: a Telegram
// bot binds to a PERSONALITY, and the personality does not exist until the
// recipe installs. The user was sent to a form that needed the thing they were
// trying to create.
//
// So the acceptance criterion here is literal — a machine with NO bots and NO
// personality installs morning-briefing and ends up with all three: the
// personality, a bot bound to it, and a cron job carrying a telegram origin.
//
// The fixture below is deliberately joined-up rather than stubbed apart: the
// same `bots` array the setup world writes to is the one the delivery resolver
// reads, and the same discovered-chat store is written by the install and read
// by `CronService.create`'s recomputed target set. That is what makes "the
// discovered chat becomes a GENUINE target" a thing this test can prove, rather
// than a guard that was quietly loosened.

const DATA = '/data';
const CHAT = '77712345';
const TOKEN = '5555555:AAH-secret-bot-token-value';
const BOT_KEY = 'derived-bot-key';
const BOT_LABEL = '@briefer_bot';

const FILLED = { city: 'Bengaluru', topics: 'AI infra, F1' };

const SETUP = { platform: 'telegram' as const, token: TOKEN, chatId: CHAT };

interface Options {
  /** What one-shot `getUpdates` answers. Defaults to the user's own chat. */
  discovery?: RecipeDiscoverChatsOutput;
  /** A token the live probe refuses. */
  tokenRejected?: boolean;
  cronCreateThrows?: Error;
  /** Chats already observed for the bot — the 409 fallback's evidence. */
  preObserved?: string[];
  /** A deployment with no channel-setup wiring at all. */
  noChannelSetup?: boolean;
}

function discoveredChats(): RecipeDiscoverChatsOutput {
  return {
    status: 'ok',
    botLabel: BOT_LABEL,
    chats: [{ chatId: CHAT, label: 'Mitesh', kind: 'private' }],
    error: null,
  };
}

function makeWorld(o: Options = {}) {
  const storage = new InMemoryStorage();
  const registry = new FilePersonalityRegistry(storage, DATA);
  const personalitiesService = new PersonalitiesService({
    personalities: registry,
    library: new SkillsLibrary({ dataDir: DATA, storage }),
  });

  // A machine with nothing on it. Every bot in here got there through the
  // install under test.
  const bots: DeliveryBot[] = [];
  const discovered = createDiscoveredChatStore(storage, DATA);
  const observed = new Map<string, string[]>();
  for (const chatId of o.preObserved ?? []) {
    observed.set(`telegram:${BOT_KEY}`, [...(observed.get(`telegram:${BOT_KEY}`) ?? []), chatId]);
  }

  const deliveryWorld: DeliveryTargetWorld = {
    listBots: async () => bots,
    teamMembers: async () => [],
    // No channel filter — the common fresh-machine case, where refusal rule 3
    // collapses the offered set to `observed` alone.
    channelFilter: async () => ({ enabled: true, ownerUserId: '', allowlist: [] }),
    approvedSenders: async () => [],
    observedChatIds: async (platform, botKey) => [
      ...(observed.get(`${platform}:${botKey}`) ?? []),
      ...(await discovered.list(platform, botKey)),
    ],
  };

  const jobs: ExtCronJob[] = [];
  const scheduler = {
    createJob: async (input: Partial<ExtCronJob>): Promise<ExtCronJob> => {
      if (o.cronCreateThrows) throw o.cronCreateThrows;
      const job = {
        id: `job-${jobs.length + 1}`,
        name: input.name ?? '',
        schedule: input.schedule ?? '',
        prompt: input.prompt ?? '',
        personalityId: input.personalityId ?? '',
        status: 'active',
        missedRunPolicy: input.missedRunPolicy ?? 'skip',
        createdAt: new Date().toISOString(),
        ...(input.origin ? { origin: input.origin } : {}),
      } as ExtCronJob;
      jobs.push(job);
      return job;
    },
    listJobs: async () => jobs,
    deleteJob: async (id: string) => {
      const idx = jobs.findIndex((j) => j.id === id);
      if (idx >= 0) jobs.splice(idx, 1);
    },
  } as unknown as CronScheduler;

  /** Every token read is recorded, so a test can prove where it did NOT go. */
  const tokensSeen: string[] = [];

  const channelSetup: ChannelSetupWorld = {
    platforms: ['telegram'],
    validateToken: async (_platform, token) => {
      tokensSeen.push(token);
      return o.tokenRejected
        ? { ok: false, label: null, error: 'Invalid token', retryable: false }
        : { ok: true, label: BOT_LABEL, error: null, retryable: false };
    },
    discoverChats: async (_platform, token) => {
      tokensSeen.push(token);
      return o.discovery ?? discoveredChats();
    },
    addBot: async ({ token, personalityId, username }) => {
      tokensSeen.push(token);
      if (bots.some((b) => b.botKey === BOT_KEY)) return { botKey: BOT_KEY, created: false };
      bots.push({
        platform: 'telegram',
        botKey: BOT_KEY,
        botLabel: username ? `@${username}` : BOT_KEY,
        bind: { type: 'personality', name: personalityId },
      });
      return { botKey: BOT_KEY, created: true };
    },
    removeBot: async (_platform, botKey) => {
      const idx = bots.findIndex((b) => b.botKey === botKey);
      if (idx >= 0) bots.splice(idx, 1);
    },
    recordChat: (platform, botKey, chatId) => discovered.record(platform, botKey, chatId),
    forgetChat: (platform, botKey, chatId) => discovered.forget(platform, botKey, chatId),
  };

  const mcp: RecipesServiceOptions['mcp'] = {
    list: async () => ({
      servers: [
        {
          name: 'google-calendar',
          transport: 'stdio' as const,
          command: 'npx',
          url: null,
          auth_status: 'authorized' as const,
          created_via: null,
          mcpResultLimitChars: null,
          deprecated: false,
        },
      ],
    }),
    catalog: () => ({ remote: [], local: [] }),
    addServer: async () => ({ ok: true as const, serverName: 'unused' }),
    attachPersonalities: async () => ({ updated: ['briefer'], failed: [] }),
    delete: async () => ({ ok: true as const }),
  };

  const tools: Tool[] = morningBriefing.requires.tools.map(
    (name) => ({ name, description: name, toolset: 'test' }) as Tool,
  );

  const recipes = new RecipesService({
    personalities: {
      list: personalitiesService.list.bind(personalitiesService),
      exists: personalitiesService.exists.bind(personalitiesService),
      get: personalitiesService.get.bind(personalitiesService),
      config: personalitiesService.config.bind(personalitiesService),
      create: personalitiesService.create.bind(personalitiesService),
      update: personalitiesService.update.bind(personalitiesService),
      delete: personalitiesService.delete.bind(personalitiesService),
    },
    cron: new CronService({ scheduler, deliveryWorld }),
    mcp,
    toolRegistry: { getAvailable: () => tools },
    ...(o.noChannelSetup ? {} : { channelSetup }),
    storage,
    dataDir: DATA,
  });

  return { recipes, registry, jobs, bots, discovered, deliveryWorld, tokensSeen, storage };
}

async function installWithSetup(recipes: RecipesService, over: Partial<typeof SETUP> = {}) {
  return recipes.install({
    id: 'morning-briefing',
    version: morningBriefing.version,
    inputs: FILLED,
    channelSetup: { ...SETUP, ...over },
  });
}

// ---------------------------------------------------------------------------
// The acceptance criterion
// ---------------------------------------------------------------------------

describe('recipes.install — inline channel setup', () => {
  it('turns an empty machine into a personality, a bound bot and a delivering job', async () => {
    const { recipes, registry, jobs, bots } = makeWorld();

    // The starting world: no bots, no personality. Exactly what the user had.
    expect(bots).toEqual([]);
    expect(registry.describe('briefer')).toBeNull();

    const report = await installWithSetup(recipes);

    expect(report.ok).toBe(true);
    expect(report.created.personality).toBe('briefer');
    expect(report.created.channelBot).toBe(BOT_LABEL);
    expect(report.created.cronJobs).toEqual(['morning briefing']);

    // The bot exists and speaks for the personality this same install wrote.
    expect(bots).toEqual([
      {
        platform: 'telegram',
        botKey: BOT_KEY,
        botLabel: BOT_LABEL,
        bind: { type: 'personality', name: 'briefer' },
      },
    ]);

    // And the job delivers to the phone, not to a file.
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.origin).toEqual({ platform: 'telegram', chatId: CHAT });
  });

  it('makes the discovered chat a REAL target rather than relaxing the guard', async () => {
    const { recipes, deliveryWorld } = makeWorld();
    await installWithSetup(recipes);

    // `CronService.create` accepted the target above because this is now true —
    // the resolver, recomputed from scratch, offers the chat on its own.
    const { targets } = await resolveDeliveryTargets(deliveryWorld, 'briefer');
    expect(targets).toEqual([
      {
        platform: 'telegram',
        botKey: BOT_KEY,
        botLabel: BOT_LABEL,
        chatId: CHAT,
        label: 'you have messaged this bot here',
        source: 'observed',
      },
    ]);
  });

  it('validates the token before it is used, and never echoes it back', async () => {
    const { recipes, bots, tokensSeen } = makeWorld({ tokenRejected: true });

    await expect(installWithSetup(recipes)).rejects.toMatchObject({
      code: 'RECIPE_CHANNEL_SETUP_FAILED',
    });

    // Refused at the probe: no discovery ran, no bot was added, nothing wrote.
    expect(tokensSeen).toEqual([TOKEN]);
    expect(bots).toEqual([]);
  });

  it('keeps the token out of every message it produces', async () => {
    const { recipes } = makeWorld({ tokenRejected: true });
    try {
      await installWithSetup(recipes);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isEthosError(err)).toBe(true);
      // A credential in an error string ends up in a log, a bug report and a
      // screenshot. `@botname` is the only thing about it that may surface.
      const rendered = JSON.stringify(err);
      expect(rendered).not.toContain(TOKEN);
    }
  });

  it('never returns the token from a successful install either', async () => {
    const { recipes } = makeWorld();
    const report = await installWithSetup(recipes);
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  });

  it('refuses a chat that has not actually messaged the bot', async () => {
    const { recipes, registry, bots } = makeWorld();

    // The client can send any chatId it likes; the server re-reads Telegram.
    await expect(installWithSetup(recipes, { chatId: '999000' })).rejects.toMatchObject({
      code: 'RECIPE_CHANNEL_SETUP_FAILED',
    });
    expect(registry.describe('briefer')).toBeNull();
    expect(bots).toEqual([]);
  });

  it('refuses when nothing has messaged the bot yet', async () => {
    const { recipes } = makeWorld({
      discovery: { status: 'waiting', botLabel: BOT_LABEL, chats: [], error: null },
    });
    await expect(installWithSetup(recipes)).rejects.toMatchObject({
      code: 'RECIPE_CHANNEL_SETUP_FAILED',
    });
  });

  it('refuses to be given both an existing target and a new bot', async () => {
    const { recipes } = makeWorld();
    await expect(
      recipes.install({
        id: 'morning-briefing',
        version: morningBriefing.version,
        inputs: FILLED,
        deliverTo: { kind: 'channel', platform: 'telegram', botKey: BOT_KEY, chatId: CHAT },
        channelSetup: SETUP,
      }),
    ).rejects.toMatchObject({ code: 'RECIPE_BLOCKED' });
  });
});

// ---------------------------------------------------------------------------
// Compensation
// ---------------------------------------------------------------------------

describe('recipes.install — the bot is compensated like anything else', () => {
  it('removes the bot and forgets the chat when a later step fails', async () => {
    const { recipes, registry, bots, discovered, jobs } = makeWorld({
      cronCreateThrows: new Error('scheduler is down'),
    });

    const report = await installWithSetup(recipes);

    expect(report.ok).toBe(false);
    expect(report.created.channelBot).toBeNull();
    // LIFO: the chat recorded last is forgotten first, then the bot, then the
    // personality it was bound to.
    expect(report.rolledBack).toEqual([
      { what: `delivery target '${CHAT}'`, ok: true },
      { what: `telegram bot '${BOT_LABEL}'`, ok: true },
      { what: "personality 'briefer'", ok: true },
    ]);
    expect(report.orphaned).toEqual([]);

    // Nothing survives a failed install — including the bot it created.
    expect(bots).toEqual([]);
    expect(await discovered.list('telegram', BOT_KEY)).toEqual([]);
    expect(registry.describe('briefer')).toBeNull();
    expect(jobs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 409 — the gateway already owns this token
// ---------------------------------------------------------------------------

const CONFLICT: RecipeDiscoverChatsOutput = {
  status: 'gateway_owns_token',
  botLabel: null,
  chats: [],
  error: 'The running gateway is already receiving this bot’s messages.',
};

describe('recipes — a 409 is a fact, not a failure', () => {
  it('reports it plainly from discoverChats, with the resolved @botname', async () => {
    const { recipes } = makeWorld({ discovery: CONFLICT });
    const result = await recipes.discoverChats({ platform: 'telegram', token: TOKEN });
    expect(result.status).toBe('gateway_owns_token');
    // The token was still probed, so the page can name the bot it belongs to.
    expect(result.botLabel).toBe(BOT_LABEL);
    expect(result.chats).toEqual([]);
  });

  it('falls back to the gateway’s own record of who has messaged the bot', async () => {
    // The gateway is polling the token, so IT is the authority on this bot's
    // chats — and it has already seen this one.
    const { recipes, jobs, discovered } = makeWorld({
      discovery: CONFLICT,
      preObserved: [CHAT],
    });

    const report = await installWithSetup(recipes);

    expect(report.ok).toBe(true);
    expect(jobs[0]?.origin).toEqual({ platform: 'telegram', chatId: CHAT });
    // Nothing recorded: the evidence was already there, and inventing a second
    // copy of it would be recording something this server did not witness.
    expect(await discovered.list('telegram', BOT_KEY)).toEqual([]);
  });

  it('still refuses a chat the gateway has never seen', async () => {
    const { recipes, registry } = makeWorld({ discovery: CONFLICT });
    const report = await installWithSetup(recipes);
    expect(report.ok).toBe(false);
    expect(report.failure?.code).toBe('CRON_TARGET_NOT_ALLOWED');
    expect(registry.describe('briefer')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Preflight — the row that used to be permanent
// ---------------------------------------------------------------------------

describe('recipes.preflight — the delivery row', () => {
  it('is an unanswered question, not a blocker, on a machine with no bots', async () => {
    const { recipes } = makeWorld();
    const report = await recipes.preflight({ id: 'morning-briefing', inputs: FILLED });
    expect(report.blocking).toEqual([]);
    expect(report.needsInput.map((n) => n.key)).toEqual(['chatTarget']);
  });

  it('clears once the token and the chat arrive', async () => {
    const { recipes } = makeWorld();
    const report = await recipes.preflight({
      id: 'morning-briefing',
      // What the page writes into the input the moment a chat is picked. The
      // TOKEN is not in here on purpose — it travels on `install` alone.
      inputs: { ...FILLED, chatTarget: `telegram:${BOT_LABEL}:${CHAT}` },
    });
    expect(report.blocking).toEqual([]);
    expect(report.needsInput).toEqual([]);
  });

  it('goes back to being a blocker where the server cannot set a bot up', async () => {
    // Same bundle, a deployment with no channel-setup wiring: the requirement
    // really is unmeetable here, and preflight says so rather than offering a
    // setup panel with nothing behind it.
    const { recipes } = makeWorld({ noChannelSetup: true });
    const report = await recipes.preflight({ id: 'morning-briefing', inputs: FILLED });
    expect(report.blocking.map((b) => b.code)).toEqual(['NO_DELIVERY_TARGET']);
  });
});
