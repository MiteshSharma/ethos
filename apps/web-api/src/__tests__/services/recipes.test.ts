import { resolveCapabilities } from '@ethosagent/core';
import type { CronScheduler, CronJob as ExtCronJob } from '@ethosagent/cron';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import { morningBriefing, RECIPES } from '@ethosagent/recipes';
import { SkillsLibrary } from '@ethosagent/skills';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { isEthosError, type Tool } from '@ethosagent/types';
import { RecipeBundleWireSchema } from '@ethosagent/web-contracts';
import { describe, expect, it, vi } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
import { CronService } from '../../services/cron.service';
import type { DeliveryTargetWorld } from '../../services/cron-delivery-targets';
import { PersonalitiesService } from '../../services/personalities.service';
import { RecipesService, type RecipesServiceOptions } from '../../services/recipes.service';
import { ToolSettingsService } from '../../services/tool-settings.service';

// R2 — the goal sentence, asserted at the service level.
//
// "A user opens Recipes, clicks Morning briefing, is told what will be created
// and what is still needed from them, says go, and gets a working agent that
// messages them a digest every morning." Everything below is that sentence
// minus the pixels: the preflight list shrinking as inputs arrive, the install
// producing the personality + the MCP attachment + a cron job with a TELEGRAM
// origin, and — the failure mode this whole design exists to prevent — a
// mid-apply failure leaving nothing behind.

const DATA = '/data';
const OWNER_CHAT = '99887766';

const TELEGRAM_TARGET = {
  kind: 'channel' as const,
  platform: 'telegram',
  botKey: 'bot-a',
  chatId: OWNER_CHAT,
};

/** A world where a Telegram bot speaks for `briefer` and the owner is declared. */
function deliveryWorld(): DeliveryTargetWorld {
  return {
    listBots: async () => [
      {
        platform: 'telegram',
        botKey: 'bot-a',
        botLabel: '@briefer_bot',
        bind: { type: 'personality', name: 'briefer' },
      },
    ],
    teamMembers: async () => [],
    channelFilter: async () => ({ enabled: true, ownerUserId: OWNER_CHAT, allowlist: [] }),
    approvedSenders: async () => [],
    observedChatIds: async () => [],
  };
}

interface WorldOptions {
  /** Throw from `createJob` — forces a mid-apply failure at the last step. */
  cronCreateThrows?: Error;
  /** Throw from the personality delete — forces a COMPENSATION failure. */
  personalityDeleteThrows?: boolean;
  /** MCP servers already registered in `mcp.json`. */
  registeredMcp?: string[];
  /**
   * The Exa key the vault holds. `null` is the machine the bug report came
   * from: `web_search` is granted, reports itself available, and has no key.
   */
  searchKey?: string | null;
  /** Drop the key store entirely — the deployment cannot check credentials. */
  noKeyStore?: boolean;
  /**
   * User-named keys in the vault, beyond each provider's default `apiKey`.
   * `keys.list` surfaces these under `custom` — which is how the page can offer
   * a key called anything at all for selection.
   */
  namedKeys?: Array<{ provider: string; name: string }>;
}

/** `web_search`'s real shape: it publishes its provider roster, not the recipe. */
const WEB_SEARCH_SETTINGS: Tool['settingsSchema'] = {
  fields: [
    {
      kind: 'enum',
      key: 'provider',
      label: 'Provider',
      options: [
        { value: 'exa', label: 'Exa' },
        { value: 'tavily', label: 'Tavily' },
        { value: 'brave', label: 'Brave' },
      ],
    },
    { kind: 'secret-binding', key: 'secret', label: 'API key', secretKind: 'web-search' },
  ],
};

/** The slice of `keys.list()` the credential check reads: refs and `set`. */
function keyStore(
  exaKey: string | null,
  namedKeys: Array<{ provider: string; name: string }> = [],
): RecipesServiceOptions['keys'] {
  const entry = (id: string, label: string, provider: string, value: string | null) => ({
    id,
    category: 'tools' as const,
    label,
    shape: 'single' as const,
    fields: [
      {
        key: 'apiKey',
        label,
        ref: `providers/${provider}/apiKey`,
        preview: value ? '…key' : '<unset>',
        set: value !== null,
      },
    ],
    set: value !== null,
    canSet: true,
    canClear: true,
    getKeyUrl: `https://example.invalid/${provider}`,
  });
  // Everything the catalog does not claim surfaces under `custom` — a key the
  // user named themselves, which is exactly what the picker offers.
  const custom = namedKeys.map(({ provider, name }) => ({
    id: `custom:providers/${provider}/${name}`,
    category: 'custom' as const,
    label: `providers/${provider}/${name}`,
    shape: 'single' as const,
    fields: [
      {
        key: 'value',
        label: `providers/${provider}/${name}`,
        ref: `providers/${provider}/${name}`,
        preview: '…key',
        set: true,
      },
    ],
    set: true,
    canSet: true,
    canClear: true,
  }));
  return {
    list: async () => ({
      categories: [
        {
          id: 'tools' as const,
          entries: [
            entry('tools.exa', 'Exa', 'exa', exaKey),
            entry('tools.tavily', 'Tavily', 'tavily', null),
            entry('tools.brave', 'Brave Search', 'brave', null),
          ],
        },
        ...(custom.length > 0 ? [{ id: 'custom' as const, entries: custom }] : []),
      ],
    }),
  };
}

function makeWorld(o: WorldOptions = {}) {
  const storage = new InMemoryStorage();
  const registry = new FilePersonalityRegistry(storage, DATA);
  const personalitiesService = new PersonalitiesService({
    personalities: registry,
    library: new SkillsLibrary({ dataDir: DATA, storage }),
  });

  const jobs: ExtCronJob[] = [];
  const createJob = vi.fn(async (input: Partial<ExtCronJob>): Promise<ExtCronJob> => {
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
  });
  const scheduler = {
    createJob,
    listJobs: async () => jobs,
    deleteJob: async (id: string) => {
      const idx = jobs.findIndex((j) => j.id === id);
      if (idx >= 0) jobs.splice(idx, 1);
    },
  } as unknown as CronScheduler;
  const cronService = new CronService({ scheduler, deliveryWorld: deliveryWorld() });

  const attached: string[] = [];
  const mcp: RecipesServiceOptions['mcp'] = {
    list: async () => ({
      servers: (o.registeredMcp ?? ['google-calendar']).map((name) => ({
        name,
        transport: 'stdio' as const,
        command: 'npx',
        url: null,
        auth_status: 'authorized' as const,
        created_via: null,
        mcpResultLimitChars: null,
        deprecated: false,
      })),
    }),
    catalog: () => ({ remote: [], local: [] }),
    addServer: async () => ({ ok: true as const, serverName: 'unused' }),
    attachPersonalities: async ({ serverName }) => {
      attached.push(serverName);
      return { updated: ['briefer'], failed: [] };
    },
    delete: async () => ({ ok: true as const }),
  };

  const tools: Tool[] = morningBriefing.requires.tools.map(
    (name) =>
      ({
        name,
        description: name,
        toolset: 'test',
        ...(name === 'web_search' ? { settingsSchema: WEB_SEARCH_SETTINGS } : {}),
      }) as Tool,
  );

  const personalities = o.personalityDeleteThrows
    ? {
        ...bindService(personalitiesService),
        delete: async () => {
          throw new Error('disk is read-only');
        },
      }
    : bindService(personalitiesService);

  // The real service, not a stub: the binding this install writes has to land
  // in the same `tools.yaml` the personality's own Tools tab reads.
  const toolSettings = new ToolSettingsService({
    config: new ConfigRepository({
      dataDir: DATA,
      storage,
      secrets: new InMemorySecretsResolver(),
    }),
    personalities: personalitiesService,
  });

  const recipes = new RecipesService({
    personalities,
    cron: cronService,
    mcp,
    toolRegistry: { getAvailable: () => tools },
    ...(o.noKeyStore
      ? {}
      : {
          keys: keyStore(o.searchKey === undefined ? 'exa-key' : o.searchKey, o.namedKeys ?? []),
        }),
    toolSettings,
    storage,
    dataDir: DATA,
  });

  return { recipes, registry, jobs, attached, createJob, personalitiesService, toolSettings };
}

/** Methods lose `this` when spread, so bind the ones the pipeline calls. */
function bindService(s: PersonalitiesService): RecipesServiceOptions['personalities'] {
  return {
    exists: s.exists.bind(s),
    get: s.get.bind(s),
    create: s.create.bind(s),
    update: s.update.bind(s),
    delete: s.delete.bind(s),
  };
}

const FILLED = { city: 'Bengaluru', topics: 'AI infra, F1' };

// ---------------------------------------------------------------------------
// Catalog + the wire mirror
// ---------------------------------------------------------------------------

describe('recipes catalog', () => {
  it('lists every shipped bundle', () => {
    const { recipes } = makeWorld();
    const { recipes: rows } = recipes.list();
    expect(rows.map((r) => r.id)).toEqual(RECIPES.map((r) => r.id));
  });

  it('every shipped bundle parses through the wire schema', () => {
    // The `recipes` namespace MIRRORS `RecipeBundleSchema` rather than
    // importing it (web-contracts sits below the extensions layer). This is
    // what keeps the mirror honest.
    for (const bundle of RECIPES) {
      expect(() => RecipeBundleWireSchema.parse(bundle)).not.toThrow();
    }
    // A mirror field that is MISSING does not throw — zod strips it — so the
    // fields the UI needs are asserted through, not just parsed.
    const wire = RecipeBundleWireSchema.parse(morningBriefing);
    expect(wire.requires.secrets?.map((s) => s.toolName)).toEqual(['web_search']);
  });

  it('refuses an unknown id with RECIPE_NOT_FOUND', () => {
    const { recipes } = makeWorld();
    try {
      recipes.get('no-such-recipe');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isEthosError(err) && err.code).toBe('RECIPE_NOT_FOUND');
    }
  });
});

// ---------------------------------------------------------------------------
// Stage 2/3 — preflight
// ---------------------------------------------------------------------------

describe('recipes.preflight', () => {
  it('shrinks the "still needed from you" list as inputs arrive', async () => {
    const { recipes } = makeWorld();

    const empty = await recipes.preflight({ id: 'morning-briefing' });
    // `units` and `briefingTime` carry defaults, so they are already answered.
    expect(empty.needsInput.map((n) => n.key)).toEqual(['city', 'topics', 'chatTarget']);
    expect(empty.blocking).toEqual([]);

    const partial = await recipes.preflight({ id: 'morning-briefing', inputs: FILLED });
    expect(partial.needsInput.map((n) => n.key)).toEqual(['chatTarget']);

    const full = await recipes.preflight({
      id: 'morning-briefing',
      inputs: { ...FILLED, chatTarget: `telegram:bot-a:${OWNER_CHAT}` },
    });
    expect(full.needsInput).toEqual([]);
  });

  it('returns the character sheet in the same payload — the preview IS the sheet (D5)', async () => {
    const { recipes } = makeWorld();
    const report = await recipes.preflight({ id: 'morning-briefing', inputs: FILLED });
    // Identity, routing, toolset, MCP servers, fs_reach — the same artifact
    // `ethos personality show` prints, rendered from a config that does not
    // exist on disk yet.
    expect(report.characterSheet).toContain('briefer — Briefer');
    expect(report.characterSheet).toContain('web_extract');
    expect(report.characterSheet).toContain('google-calendar');
    // Substitution happens before rendering, so no placeholder ever reaches a
    // surface a user reads.
    expect(report.characterSheet).not.toContain('{{input.');
    expect(report.postInstall.map((p) => p.kind)).toEqual(['manual', 'restart']);
  });

  it('previews the resolved schedule and its next fire time', async () => {
    const { recipes } = makeWorld();
    const report = await recipes.preflight({ id: 'morning-briefing', inputs: FILLED });
    const job = report.willCreate.cronJobs[0];
    expect(job?.schedule).toBe('20 6 * * *');
    expect(job?.nextRun).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.willCreate.personality).toEqual({ id: 'briefer', isNew: true });
    expect(report.willCreate.mcpAttachments).toEqual(['google-calendar']);
  });

  it('is installable with no MCP servers registered — the calendar is optional (D13)', async () => {
    const { recipes } = makeWorld({ registeredMcp: [] });
    const report = await recipes.preflight({ id: 'morning-briefing', inputs: FILLED });
    expect(report.blocking).toEqual([]);
    expect(report.warnings.map((w) => w.code)).toContain('MCP_SERVER_OPTIONAL_MISSING');
    // The web API refuses stdio transport on purpose, so the warning has to
    // carry the terminal command rather than pointing at a button.
    const warning = report.warnings.find((w) => w.code === 'MCP_SERVER_OPTIONAL_MISSING');
    expect(warning?.message).toContain('ethos mcp add google-calendar');
    expect(report.willCreate.mcpAttachments).toEqual([]);
  });

  it('warns — never blocks — when the gateway is not running', async () => {
    const { recipes } = makeWorld();
    const report = await recipes.preflight({ id: 'morning-briefing', inputs: FILLED });
    expect(report.warnings.map((w) => w.code)).toContain('GATEWAY_NOT_RUNNING');
  });

  it('writes nothing', async () => {
    const { recipes, registry, jobs } = makeWorld();
    await recipes.preflight({ id: 'morning-briefing', inputs: FILLED });
    expect(registry.describe('briefer')).toBeNull();
    expect(jobs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stage 5/6 — install
// ---------------------------------------------------------------------------

describe('recipes.install', () => {
  it('installs morning-briefing end to end, with a channel-origin cron job', async () => {
    const { recipes, registry, jobs, attached } = makeWorld();

    const report = await recipes.install({
      id: 'morning-briefing',
      version: morningBriefing.version,
      inputs: FILLED,
      deliverTo: TELEGRAM_TARGET,
    });

    expect(report.ok).toBe(true);
    expect(report.failure).toBeNull();
    expect(report.created.personality).toBe('briefer');
    expect(report.created.cronJobs).toEqual(['morning briefing']);
    expect(report.created.mcpAttachments).toEqual(['google-calendar']);
    expect(report.rolledBack).toEqual([]);
    expect(report.orphaned).toEqual([]);
    // Honest completion (D6): everything installable is installed, and what is
    // left is a short, specific checklist.
    expect(report.remaining.map((r) => r.kind)).toEqual(['manual', 'restart']);
    expect(report.starterPrompt).toBe(morningBriefing.starterPrompt);

    // The personality is real, and its SOUL carries the substituted inputs.
    const created = registry.describe('briefer');
    expect(created?.config.mcp_servers).toEqual(['google-calendar']);
    expect(created?.config.toolset).toEqual(morningBriefing.personality.toolset);
    const soul = await registry.readSoulMd('briefer');
    expect(soul).toContain('city: Bengaluru');
    expect(soul).not.toContain('{{input.');
    expect(attached).toEqual(['google-calendar']);

    // The whole point of §1: the job delivers to the user's phone, not to a
    // file nobody reads.
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.schedule).toBe('20 6 * * *');
    expect(jobs[0]?.origin).toEqual({ platform: 'telegram', chatId: OWNER_CHAT });
  });

  it('installs on a machine with no MCP servers, skipping the optional one (D13)', async () => {
    const { recipes, registry, jobs, attached } = makeWorld({ registeredMcp: [] });

    const report = await recipes.install({
      id: 'morning-briefing',
      version: morningBriefing.version,
      inputs: FILLED,
      deliverTo: TELEGRAM_TARGET,
    });

    expect(report.ok).toBe(true);
    expect(report.failure).toBeNull();
    expect(report.created.personality).toBe('briefer');
    expect(report.created.cronJobs).toEqual(['morning briefing']);
    expect(report.created.mcpAttachments).toEqual([]);
    expect(report.skipped).toContainEqual({
      what: "MCP server 'google-calendar'",
      because: 'it is optional and not registered on this machine',
    });
    expect(attached).toEqual([]);
    expect(jobs).toHaveLength(1);
    // The allowlist entry survives: naming a server that is not registered is
    // inert, and it means the section starts working the day the user adds it.
    expect(registry.describe('briefer')?.config.mcp_servers).toEqual(['google-calendar']);
  });

  it('refuses a stale preview with RECIPE_STALE', async () => {
    const { recipes, registry } = makeWorld();
    await expect(
      recipes.install({
        id: 'morning-briefing',
        version: morningBriefing.version + 1,
        inputs: FILLED,
        deliverTo: TELEGRAM_TARGET,
      }),
    ).rejects.toMatchObject({ code: 'RECIPE_STALE' });
    expect(registry.describe('briefer')).toBeNull();
  });

  it('refuses an unfilled required input with RECIPE_BLOCKED, before any write', async () => {
    const { recipes, registry, jobs } = makeWorld();
    await expect(
      recipes.install({
        id: 'morning-briefing',
        version: morningBriefing.version,
        inputs: { city: 'Bengaluru' },
        deliverTo: TELEGRAM_TARGET,
      }),
    ).rejects.toMatchObject({ code: 'RECIPE_BLOCKED' });
    expect(registry.describe('briefer')).toBeNull();
    expect(jobs).toEqual([]);
  });

  it('refuses a channel-delivering recipe with no chosen target', async () => {
    const { recipes, registry } = makeWorld();
    await expect(
      recipes.install({
        id: 'morning-briefing',
        version: morningBriefing.version,
        inputs: { ...FILLED, chatTarget: 'telegram:bot-a:whatever' },
      }),
    ).rejects.toMatchObject({ code: 'RECIPE_BLOCKED' });
    expect(registry.describe('briefer')).toBeNull();
  });

  it('surfaces CronService’s target refusal instead of swallowing it', async () => {
    const { recipes, registry } = makeWorld();
    const report = await recipes.install({
      id: 'morning-briefing',
      version: morningBriefing.version,
      inputs: FILLED,
      // A chat nobody vouched for — recomputed server-side, never trusted.
      deliverTo: { ...TELEGRAM_TARGET, chatId: '4040404' },
    });
    expect(report.ok).toBe(false);
    expect(report.failure?.code).toBe('CRON_TARGET_NOT_ALLOWED');
    expect(registry.describe('briefer')).toBeNull();
  });

  it('leaves NO partial state when a mid-apply step fails', async () => {
    const { recipes, registry, jobs } = makeWorld({
      cronCreateThrows: new Error('scheduler is down'),
    });

    const report = await recipes.install({
      id: 'morning-briefing',
      version: morningBriefing.version,
      inputs: FILLED,
      deliverTo: TELEGRAM_TARGET,
    });

    expect(report.ok).toBe(false);
    expect(report.created).toEqual({
      personality: null,
      channelBot: null,
      cronJobs: [],
      mcpAttachments: [],
    });
    expect(report.failure?.code).toBe('CRON_INVALID');
    expect(report.rolledBack).toEqual([{ what: "personality 'briefer'", ok: true }]);
    expect(report.orphaned).toEqual([]);
    // The whole reason the design exists: nothing survives a failed install.
    expect(registry.describe('briefer')).toBeNull();
    expect(jobs).toEqual([]);
  });

  it('names an orphan when compensation itself fails', async () => {
    const { recipes } = makeWorld({
      cronCreateThrows: new Error('scheduler is down'),
      personalityDeleteThrows: true,
    });

    const report = await recipes.install({
      id: 'morning-briefing',
      version: morningBriefing.version,
      inputs: FILLED,
      deliverTo: TELEGRAM_TARGET,
    });

    expect(report.ok).toBe(false);
    expect(report.rolledBack).toEqual([{ what: "personality 'briefer'", ok: false }]);
    expect(report.orphaned).toEqual([{ what: "personality 'briefer'", href: '/personalities' }]);
  });

  it('is idempotent — a second install creates nothing and reports skips', async () => {
    const { recipes, registry, jobs } = makeWorld();
    const args = {
      id: 'morning-briefing',
      version: morningBriefing.version,
      inputs: FILLED,
      deliverTo: TELEGRAM_TARGET,
    };
    await recipes.install(args);
    const second = await recipes.install(args);

    expect(second.ok).toBe(true);
    expect(second.created.personality).toBeNull();
    expect(second.created.cronJobs).toEqual([]);
    expect(second.created.mcpAttachments).toEqual([]);
    expect(second.skipped.map((s) => s.what)).toEqual([
      "personality 'briefer'",
      "MCP attachment 'google-calendar'",
      "cron job 'morning briefing'",
    ]);
    expect(registry.describe('briefer')).not.toBeNull();
    expect(jobs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The two prerequisites a fresh install used to discover only at runtime
// ---------------------------------------------------------------------------

describe('recipes — network reach', () => {
  it("writes safety.network.allow: ['*'] for a bundle that declares none (D15)", async () => {
    const { recipes, registry } = makeWorld();
    await recipes.install({
      id: 'morning-briefing',
      version: morningBriefing.version,
      inputs: FILLED,
      deliverTo: TELEGRAM_TARGET,
    });
    expect(registry.describe('briefer')?.config.safety?.network).toEqual({ allow: ['*'] });
  });

  it('keeps a bundle’s own policy instead of the default', async () => {
    const { recipes, registry } = makeWorld();
    const locked = {
      ...morningBriefing,
      personality: {
        ...morningBriefing.personality,
        safety: { network: { allow: ['api.open-meteo.com'] } },
      },
    };
    const spy = vi.spyOn(RECIPES, 'find').mockReturnValue(locked);
    try {
      await recipes.install({
        id: 'morning-briefing',
        version: morningBriefing.version,
        inputs: FILLED,
        deliverTo: TELEGRAM_TARGET,
      });
    } finally {
      spy.mockRestore();
    }
    expect(registry.describe('briefer')?.config.safety?.network).toEqual({
      allow: ['api.open-meteo.com'],
    });
  });

  it('lets the installed agent actually reach api.open-meteo.com', async () => {
    // The acceptance criterion, run through the code that produced the bug.
    // `web_extract` declares `allowedHosts: ['*']`, which hands the decision to
    // the personality's policy; an ABSENT policy resolved to an empty host set
    // and denied every host with HOST_NOT_ALLOWED.
    const { recipes, registry } = makeWorld();
    await recipes.install({
      id: 'morning-briefing',
      version: morningBriefing.version,
      inputs: FILLED,
      deliverTo: TELEGRAM_TARGET,
    });
    const policy = registry.describe('briefer')?.config.safety?.network;

    const response = new Response('{}');
    const resolved = resolveCapabilities(
      'web_extract',
      { network: { allowedHosts: ['*'] } },
      { personalityId: 'briefer', sessionId: 'web:test' },
      {
        ...(policy ? { personalityNetworkPolicy: () => policy } : {}),
        safeFetch: async (url) => ({ ok: true as const, response, finalUrl: url, hops: 0 }),
      },
    );
    await expect(
      resolved.scopedFetch?.fetch('https://api.open-meteo.com/v1/forecast'),
    ).resolves.toBe(response);
  });
});

describe('recipes — the web-search credential', () => {
  it('asks for a key before install, and clears once one is set', async () => {
    const missing = makeWorld({ searchKey: null });
    const before = await missing.recipes.preflight({ id: 'morning-briefing', inputs: FILLED });
    const row = before.needsInput.find((r) => r.kind === 'credential');
    expect(row?.key).toBe('secret:web_search');
    expect(row?.label).toBe('Web search API key');
    // Derived from `web_search`'s own settingsSchema, matched to key-store rows
    // through the `providers/<id>/…` ref — no provider list in the recipe layer.
    expect(row?.credentialOptions?.map((o) => o.provider)).toEqual(['exa', 'tavily', 'brave']);
    // `secretKind` comes off the tool's `secret-binding` field: it is what the
    // page's `SecretPicker` filters the vault by, so an LLM key can never be
    // offered for a search binding.
    expect(row?.secretKind).toBe('web-search');
    // `defaultSecretName` is the ref `web_search` falls back to when nothing
    // binds it — the only reason preflight can tell "no binding, default key
    // present" from "unset".
    expect(row?.credentialOptions?.[0]).toEqual({
      provider: 'exa',
      label: 'Exa',
      defaultSecretName: 'apiKey',
      getKeyUrl: 'https://example.invalid/exa',
    });

    const set = makeWorld({ searchKey: 'exa-key' });
    const after = await set.recipes.preflight({ id: 'morning-briefing', inputs: FILLED });
    expect(after.needsInput.find((r) => r.kind === 'credential')).toBeUndefined();
  });

  it('offers a user-named key for selection, and clears the row when one is picked', async () => {
    // The machine the feedback came from: a key IS in the vault, just not under
    // the tool's default name. The row must be answerable by SELECTING it.
    const { recipes } = makeWorld({
      searchKey: null,
      namedKeys: [{ provider: 'exa', name: 'work' }],
    });
    const before = await recipes.preflight({ id: 'morning-briefing', inputs: FILLED });
    expect(before.needsInput.find((r) => r.kind === 'credential')).toBeDefined();

    const after = await recipes.preflight({
      id: 'morning-briefing',
      inputs: FILLED,
      secretBindings: { web_search: { provider: 'exa', secret: 'work' } },
    });
    expect(after.needsInput.find((r) => r.kind === 'credential')).toBeUndefined();
  });

  it('writes the binding for a key that is not the default name', async () => {
    const { recipes, registry } = makeWorld({
      searchKey: null,
      namedKeys: [{ provider: 'exa', name: 'work' }],
    });
    const report = await recipes.install({
      id: 'morning-briefing',
      version: morningBriefing.version,
      inputs: FILLED,
      deliverTo: TELEGRAM_TARGET,
      secretBindings: { web_search: { provider: 'exa', secret: 'work' } },
    });
    expect(report.ok).toBe(true);
    // Without this the agent resolves `providers/exa/apiKey`, finds nothing,
    // and returns no results without saying why.
    expect(registry.getToolsConfig('briefer')).toEqual({
      web_search: { provider: 'exa', secret: 'work' },
    });
  });

  it('compensates the binding when a later stage fails', async () => {
    const { recipes, registry } = makeWorld({
      searchKey: null,
      namedKeys: [{ provider: 'exa', name: 'work' }],
      cronCreateThrows: new Error('scheduler is down'),
    });
    const report = await recipes.install({
      id: 'morning-briefing',
      version: morningBriefing.version,
      inputs: FILLED,
      deliverTo: TELEGRAM_TARGET,
      secretBindings: { web_search: { provider: 'exa', secret: 'work' } },
    });
    expect(report.ok).toBe(false);
    expect(report.rolledBack.map((r) => r.what)).toContain("web_search key binding on 'briefer'");
    expect(report.orphaned).toEqual([]);
    expect(registry.describe('briefer')).toBeNull();
  });

  it('refuses a binding that names a key the vault does not hold', async () => {
    // "Some key of this kind exists" is not the question: the default key IS
    // set here, but the binding would send the tool to a ref that resolves to
    // nothing. Preflight's check runs against the binding, so this refuses.
    const { recipes, registry } = makeWorld({ searchKey: 'exa-key' });
    await expect(
      recipes.install({
        id: 'morning-briefing',
        version: morningBriefing.version,
        inputs: FILLED,
        deliverTo: TELEGRAM_TARGET,
        secretBindings: { web_search: { provider: 'exa', secret: 'typo' } },
      }),
    ).rejects.toMatchObject({ code: 'RECIPE_BLOCKED' });
    expect(registry.describe('briefer')).toBeNull();
  });

  it('leaves the personality unbound when the default key already answers it', async () => {
    // Nothing was picked, because nothing needed picking. Writing a binding
    // anyway would pin a provider the user never chose.
    const { recipes, registry } = makeWorld({ searchKey: 'exa-key' });
    await recipes.install({
      id: 'morning-briefing',
      version: morningBriefing.version,
      inputs: FILLED,
      deliverTo: TELEGRAM_TARGET,
    });
    expect(registry.getToolsConfig('briefer')).toBeUndefined();
  });

  it('refuses the install while the key is missing, before any write', async () => {
    const { recipes, registry, jobs } = makeWorld({ searchKey: null });
    await expect(
      recipes.install({
        id: 'morning-briefing',
        version: morningBriefing.version,
        inputs: FILLED,
        deliverTo: TELEGRAM_TARGET,
      }),
    ).rejects.toMatchObject({ code: 'RECIPE_BLOCKED' });
    expect(registry.describe('briefer')).toBeNull();
    expect(jobs).toEqual([]);
  });

  it('warns instead of blocking when no key store is wired', async () => {
    // A deployment that cannot check must not emit a row nothing can clear.
    const { recipes } = makeWorld({ noKeyStore: true });
    const report = await recipes.preflight({ id: 'morning-briefing', inputs: FILLED });
    expect(report.needsInput.find((r) => r.kind === 'credential')).toBeUndefined();
    expect(report.warnings.map((w) => w.code)).toContain('SECRET_STATUS_UNKNOWN');
  });

  it('never lets a key value into a preflight, an install report or an error', async () => {
    // Mirrors the bot-token test in `recipes-channel-setup.test.ts`. The value
    // is written through the named-secrets vault and read back only as
    // `set: true`; nothing in this pipeline ever holds one. Only the NAME half
    // of a ref travels, which is what makes the binding safe to carry.
    const { recipes } = makeWorld({
      searchKey: 'exa-key',
      namedKeys: [{ provider: 'exa', name: 'work' }],
    });
    const bound = { web_search: { provider: 'exa', secret: 'work' } };
    const preflight = await recipes.preflight({
      id: 'morning-briefing',
      inputs: FILLED,
      secretBindings: bound,
    });
    expect(JSON.stringify(preflight)).not.toContain('exa-key');
    const report = await recipes.install({
      id: 'morning-briefing',
      version: morningBriefing.version,
      inputs: FILLED,
      deliverTo: TELEGRAM_TARGET,
      secretBindings: bound,
    });
    expect(JSON.stringify(report)).not.toContain('exa-key');

    // ...and the refusal path, where a message is built from the report.
    const blocked = makeWorld({ searchKey: 'exa-key' });
    const error = await blocked.recipes
      .install({
        id: 'morning-briefing',
        version: morningBriefing.version,
        inputs: FILLED,
        deliverTo: TELEGRAM_TARGET,
        secretBindings: { web_search: { provider: 'exa', secret: 'typo' } },
      })
      .catch((err: unknown) => err);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('exa-key');
  });

  it('surfaces BOTH prerequisites on a bare machine, before anything is written', async () => {
    // The acceptance scenario: a fresh install with no search key. The delivery
    // target and the credential are both answerable questions on the page, and
    // the install refuses until they are answered.
    const { recipes, registry } = makeWorld({ searchKey: null });
    const report = await recipes.preflight({ id: 'morning-briefing', inputs: FILLED });
    expect(report.needsInput.map((r) => r.kind).sort()).toEqual(['chatTarget', 'credential']);
    expect(report.blocking).toEqual([]);
    expect(registry.describe('briefer')).toBeNull();
  });
});
