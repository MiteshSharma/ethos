// Preflight unit tests (plan §7) over a synthetic world snapshot: each blocking
// condition produces exactly one row carrying an action, and a satisfied
// prerequisite produces none.

import { describe, expect, it } from 'vitest';
import { morningBriefing, obsidianSecondBrain as obsidianBoth } from '../data';
import { preflightRecipe, type RecipeWorldSnapshot, unknownToolNames } from '../preflight';
import { projectBundle, type RecipeBundle } from '../schema';
import { recipeSoulMarkers, renderTemplatePreview } from '../template';

const FILLED = {
  city: 'Bengaluru',
  units: 'metric',
  topics: 'AI infra, F1',
  briefingTime: '20 6 * * *',
  chatTarget: '12345',
};

const SEARCH_OPTION = { provider: 'exa', label: 'Exa', defaultSecretName: 'apiKey' };

/** A `secretStatus` entry over one provider, with whatever keys it holds. */
function searchKeys(...names: string[]): NonNullable<RecipeWorldSnapshot['secretStatus']> {
  return {
    web_search: {
      secretKind: 'web-search',
      options: [SEARCH_OPTION],
      existing: names.map((name) => ({ provider: 'exa', name })),
    },
  };
}

/** A machine on which morning-briefing installs cleanly. */
function happyWorld(): RecipeWorldSnapshot {
  return {
    personalities: [],
    availableTools: [...morningBriefing.requires.tools, ...morningBriefing.personality.toolset],
    mcpServers: ['google-calendar'],
    mcpCatalogIds: [],
    plugins: [],
    hostBinaries: [],
    cronJobNames: [],
    deliveryTargets: [
      { platform: 'telegram', botKey: 'bot1', chatId: '12345', label: 'your owner chat' },
    ],
    gatewayRunning: true,
    // A machine that already has a search key. The recipe grants `web_search`,
    // and `web_search` cannot report its own missing key — `isAvailable()` is
    // unconditionally true — so this is the only fact that answers it.
    secretStatus: searchKeys('apiKey'),
  };
}

function run(
  snapshot: RecipeWorldSnapshot,
  inputs = FILLED,
  bundle: RecipeBundle = morningBriefing,
  secretBindings?: Record<string, { provider: string; secret: string }>,
) {
  return preflightRecipe({
    bundle,
    snapshot,
    inputs,
    ...(secretBindings ? { secretBindings } : {}),
  });
}

function codes(rows: Array<{ code: string }>): string[] {
  return rows.map((r) => r.code);
}

describe('preflightRecipe — satisfied world', () => {
  it('produces no blocking rows, no warnings and nothing still needed', () => {
    const report = run(happyWorld());
    expect(report.blocking).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.needsInput).toEqual([]);
  });

  it('reports what it would create', () => {
    const report = run(happyWorld());
    expect(report.willCreate.personality).toEqual({ id: 'briefer', isNew: true });
    expect(report.willCreate.cronJobs).toEqual([
      { name: 'morning briefing', schedule: '20 6 * * *', nextRun: null, exists: false },
    ]);
    expect(report.willCreate.mcpAttachments).toEqual(['google-calendar']);
  });

  it('carries nextRun through from the snapshot when the caller computed one', () => {
    const report = run({ ...happyWorld(), nextRunBySchedule: { '20 6 * * *': 'tomorrow 06:20' } });
    expect(report.willCreate.cronJobs[0]?.nextRun).toBe('tomorrow 06:20');
  });

  it('marks an existing job of the same name as already there', () => {
    const report = run({ ...happyWorld(), cronJobNames: ['morning briefing'] });
    expect(report.willCreate.cronJobs[0]?.exists).toBe(true);
  });
});

describe('preflightRecipe — inputs', () => {
  it('asks only for required inputs that are still blank', () => {
    const report = preflightRecipe({
      bundle: morningBriefing,
      snapshot: happyWorld(),
      inputs: { city: 'Berlin' },
    });
    // `units` and `briefingTime` have defaults, so they are already satisfied.
    expect(report.needsInput.map((r) => r.key)).toEqual(['topics', 'chatTarget']);
    expect(report.needsInput[0]?.suggested).toBe('AI infra, Indian startups, F1');
  });

  it('shrinks as the user fills the form in', () => {
    const partial = preflightRecipe({
      bundle: morningBriefing,
      snapshot: happyWorld(),
      inputs: { city: 'Berlin', topics: 'F1' },
    });
    expect(partial.needsInput.map((r) => r.key)).toEqual(['chatTarget']);
  });

  it('keeps an unresolved schedule as its placeholder rather than guessing', () => {
    // A declared default satisfies the input, so drop it to leave one unfilled.
    const noDefault: RecipeBundle = {
      ...morningBriefing,
      requires: {
        ...morningBriefing.requires,
        inputs: morningBriefing.requires.inputs.map((i) =>
          i.key === 'briefingTime' ? { ...i, default: undefined } : i,
        ),
      },
    };
    const report = preflightRecipe({
      bundle: noDefault,
      snapshot: happyWorld(),
      inputs: { ...FILLED, briefingTime: '' },
    });
    expect(report.willCreate.cronJobs[0]?.schedule).toBe('{{input.briefingTime}}');
    expect(report.needsInput.map((r) => r.key)).toEqual(['briefingTime']);
  });
});

describe('preflightRecipe — personality collision', () => {
  it('blocks once when the id belongs to a different personality', () => {
    const report = run({
      ...happyWorld(),
      personalities: [{ id: 'briefer', soulMd: 'Someone else entirely.', toolset: ['read_file'] }],
    });
    expect(codes(report.blocking)).toEqual(['PERSONALITY_ID_TAKEN']);
    expect(report.blocking[0]?.action).toContain('briefer');
    expect(report.blocking[0]?.href).toBe('/personalities');
    expect(report.willCreate.personality.isNew).toBe(false);
  });

  it('does not block when the id holds what this same bundle would write', () => {
    const report = run({
      ...happyWorld(),
      personalities: [
        {
          id: 'briefer',
          soulMd: renderTemplatePreview(morningBriefing.personality.soulMd, FILLED),
          toolset: [...morningBriefing.personality.toolset].reverse(),
        },
      ],
    });
    expect(report.blocking).toEqual([]);
    expect(report.willCreate.personality.isNew).toBe(false);
  });

  it('honours a personality id override', () => {
    const report = preflightRecipe({
      bundle: morningBriefing,
      snapshot: {
        ...happyWorld(),
        personalities: [{ id: 'briefer', soulMd: 'other', toolset: [] }],
      },
      inputs: FILLED,
      personalityId: 'briefer-2',
    });
    expect(report.blocking).toEqual([]);
    expect(report.willCreate.personality).toEqual({ id: 'briefer-2', isNew: true });
  });
});

describe('preflightRecipe — tools', () => {
  it('blocks once per unavailable tool, with an action', () => {
    const world = happyWorld();
    const report = run({
      ...world,
      availableTools: world.availableTools.filter((t) => t !== 'web_search'),
    });
    expect(codes(report.blocking)).toEqual(['TOOL_UNAVAILABLE']);
    expect(report.blocking[0]?.message).toContain('web_search');
    expect(report.blocking[0]?.action).not.toBe('');
  });
});

describe('preflightRecipe — MCP servers', () => {
  /** The same bundle with its one server marked required again. */
  const required: RecipeBundle = {
    ...morningBriefing,
    requires: {
      ...morningBriefing.requires,
      mcpServers: morningBriefing.requires.mcpServers.map((s) => ({ ...s, optional: false })),
    },
  };

  it('blocks when a REQUIRED server is neither registered nor a catalog preset', () => {
    const report = run({ ...happyWorld(), mcpServers: [] }, FILLED, required);
    expect(codes(report.blocking)).toEqual(['MCP_SERVER_MISSING']);
    expect(report.blocking[0]?.href).toBe('/mcp');
    expect(report.willCreate.mcpAttachments).toEqual([]);
  });

  it('warns instead of blocking when an OPTIONAL server is missing (D13)', () => {
    const report = run({ ...happyWorld(), mcpServers: [] });
    expect(report.blocking).toEqual([]);
    expect(codes(report.warnings)).toEqual(['MCP_SERVER_OPTIONAL_MISSING']);
    expect(report.willCreate.mcpAttachments).toEqual([]);
  });

  it('names the exact terminal command, since the web UI cannot add a stdio server', () => {
    const report = run({ ...happyWorld(), mcpServers: [] });
    const message = report.warnings[0]?.message ?? '';
    expect(message).toContain('The web UI cannot add a stdio server.');
    expect(message).toContain(
      'ethos mcp add google-calendar --env GOOGLE_OAUTH_CREDENTIALS=<value> --command npx --args -y @cocal/google-calendar-mcp',
    );
  });

  it('attaches an optional server that IS registered, like any other', () => {
    const report = run(happyWorld());
    expect(report.warnings).toEqual([]);
    expect(report.willCreate.mcpAttachments).toEqual(['google-calendar']);
  });

  it('auto-registers a credential-free catalog preset instead of blocking', () => {
    const bundle: RecipeBundle = {
      ...morningBriefing,
      personality: { ...morningBriefing.personality, mcpServers: ['fetch'] },
      requires: {
        ...morningBriefing.requires,
        mcpServers: [
          {
            name: 'fetch',
            catalogId: 'fetch',
            transport: 'stdio',
            auth: 'none',
            why: 'Keyless HTTP.',
          },
        ],
      },
    };
    const report = run(
      { ...happyWorld(), mcpServers: [], mcpCatalogIds: ['fetch'] },
      FILLED,
      bundle,
    );
    expect(report.blocking).toEqual([]);
    expect(report.willCreate.mcpAttachments).toEqual(['fetch']);
  });

  it('warns rather than blocks when a catalog preset needs credentials', () => {
    const bundle: RecipeBundle = {
      ...morningBriefing,
      requires: {
        ...morningBriefing.requires,
        mcpServers: [
          {
            ...morningBriefing.requires.mcpServers[0],
            catalogId: 'google-calendar',
          } as RecipeBundle['requires']['mcpServers'][number],
        ],
      },
    };
    const report = run(
      { ...happyWorld(), mcpServers: [], mcpCatalogIds: ['google-calendar'] },
      FILLED,
      bundle,
    );
    expect(report.blocking).toEqual([]);
    expect(codes(report.warnings)).toEqual(['MCP_SERVER_NEEDS_SETUP']);
  });
});

describe('preflightRecipe — plugins', () => {
  const withPlugin: RecipeBundle = {
    ...morningBriefing,
    personality: { ...morningBriefing.personality, plugins: ['nse'] },
    requires: {
      ...morningBriefing.requires,
      plugins: [
        { id: 'nse', packageName: '@ethosagent/tools-nse-market-data', why: 'Market data.' },
      ],
    },
  };

  it('blocks once when the plugin is not loaded', () => {
    const report = run(happyWorld(), FILLED, withPlugin);
    expect(codes(report.blocking)).toEqual(['PLUGIN_MISSING']);
    expect(report.blocking[0]?.href).toBe('/plugins');
  });

  it('surfaces yellow safety findings verbatim as warnings, never as blocks (D4)', () => {
    const report = run(
      { ...happyWorld(), plugins: [{ id: 'nse', safetyFindings: ['reads process.env'] }] },
      FILLED,
      withPlugin,
    );
    expect(report.blocking).toEqual([]);
    expect(report.warnings).toEqual([
      { code: 'PLUGIN_SAFETY_FINDING', message: 'nse: reads process.env' },
    ]);
  });

  it('produces nothing for a loaded plugin with a clean scan', () => {
    const report = run({ ...happyWorld(), plugins: [{ id: 'nse' }] }, FILLED, withPlugin);
    expect(report.blocking).toEqual([]);
    expect(report.warnings).toEqual([]);
  });
});

describe('preflightRecipe — host binaries', () => {
  const withBinary: RecipeBundle = {
    ...morningBriefing,
    requires: {
      ...morningBriefing.requires,
      hostBinaries: [
        { name: 'pdftotext', why: 'Extracts PDF text.', installHint: 'brew install poppler' },
      ],
    },
  };

  it('blocks once with the install hint as the action', () => {
    const report = run(happyWorld(), FILLED, withBinary);
    expect(codes(report.blocking)).toEqual(['HOST_BINARY_MISSING']);
    expect(report.blocking[0]?.action).toBe('brew install poppler');
  });

  it('produces nothing when the binary is present', () => {
    const report = run({ ...happyWorld(), hostBinaries: ['pdftotext'] }, FILLED, withBinary);
    expect(report.blocking).toEqual([]);
  });
});

describe('preflightRecipe — delivery', () => {
  it('blocks once when no chat can receive the scheduled output', () => {
    const report = run({ ...happyWorld(), deliveryTargets: [] });
    expect(codes(report.blocking)).toEqual(['NO_DELIVERY_TARGET']);
    expect(report.blocking[0]?.action).toContain('telegram');
    expect(report.blocking[0]?.action).toContain('briefer');
    expect(report.blocking[0]?.href).toBe('/communications');
  });

  it('keeps the blocker when the bundle allows inline setup but the server cannot', () => {
    // Both halves must agree. A bundle that declares `inlineSetup` on a
    // deployment with no channel-setup wiring still has an unmeetable
    // requirement — and saying so is better than rendering a setup panel with
    // nothing behind it.
    const report = run({ ...happyWorld(), deliveryTargets: [], inlineSetupPlatforms: [] });
    expect(codes(report.blocking)).toEqual(['NO_DELIVERY_TARGET']);
  });

  it('makes the delivery row an INPUT, not a blocker, when the bot can be set up here', () => {
    // The chicken-and-egg this exists to kill: a Telegram bot binds to a
    // PERSONALITY, and `briefer` does not exist until this recipe installs, so
    // "bind a bot to this agent in Communications" could never be done. With
    // inline setup available the requirement is answerable ON THE PAGE, so it
    // belongs in `needsInput` — where it clears — not in `blocking`.
    const report = run(
      { ...happyWorld(), deliveryTargets: [], inlineSetupPlatforms: ['telegram'] },
      { ...FILLED, chatTarget: '' },
    );
    expect(codes(report.blocking)).toEqual([]);
    expect(report.needsInput.map((n) => n.key)).toEqual(['chatTarget']);
  });

  it('clears the delivery row once the chat arrives', () => {
    const report = run({
      ...happyWorld(),
      deliveryTargets: [],
      inlineSetupPlatforms: ['telegram'],
    });
    expect(report.blocking).toEqual([]);
    expect(report.needsInput).toEqual([]);
  });

  it('does not ask for a delivery target when no job delivers to a channel', () => {
    const bundle: RecipeBundle = {
      ...morningBriefing,
      cronJobs: morningBriefing.cronJobs.map((j) => ({ ...j, deliverTo: 'inApp' as const })),
    };
    const report = run({ ...happyWorld(), deliveryTargets: [] }, FILLED, bundle);
    expect(report.blocking).toEqual([]);
  });

  it('warns when the gateway is not running', () => {
    const report = run({ ...happyWorld(), gatewayRunning: false });
    expect(report.blocking).toEqual([]);
    expect(codes(report.warnings)).toEqual(['GATEWAY_NOT_RUNNING']);
  });
});

describe('morning-briefing on a bare machine', () => {
  it('is installable with NO MCP servers registered at all (the D13 acceptance test)', () => {
    const report = run({ ...happyWorld(), mcpServers: [], mcpCatalogIds: [] });
    // Nothing left to decide: the recipe ships weather + news + todos, and the
    // calendar is a warning the user can act on later from a terminal.
    expect(report.blocking).toEqual([]);
    expect(report.needsInput).toEqual([]);
    expect(codes(report.warnings)).toEqual(['MCP_SERVER_OPTIONAL_MISSING']);
    expect(report.willCreate.personality).toEqual({ id: 'briefer', isNew: true });
    expect(report.willCreate.cronJobs[0]?.name).toBe('morning briefing');
  });
});

describe('unknownToolNames', () => {
  it('names every tool the deployment does not know, sorted', () => {
    expect(unknownToolNames(morningBriefing, ['web_search'])).toEqual([
      'cron',
      'memory_read',
      'memory_write',
      'session_search',
      'todo_add',
      'todo_list',
      'todo_update',
      'web_extract',
    ]);
  });

  it('is empty when every name is known', () => {
    expect(unknownToolNames(morningBriefing, morningBriefing.personality.toolset)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Credentials — the check `TOOL_UNAVAILABLE` structurally cannot make
// ---------------------------------------------------------------------------

describe('preflightRecipe — credentials', () => {
  it('asks for a missing key as an actionable row, and clears once it is set', () => {
    const missing = run({ ...happyWorld(), secretStatus: searchKeys() });
    const row = missing.needsInput.find((r) => r.kind === 'credential');
    expect(row?.key).toBe('secret:web_search');
    expect(row?.label).toBe('Web search API key');
    // Actionable means the row names what would satisfy it, and carries what
    // the page's secret picker needs to offer the vault's own keys in the flow.
    expect(row?.help).toContain('Any one of: Exa');
    expect(row?.credentialOptions).toEqual([SEARCH_OPTION]);
    expect(row?.secretKind).toBe('web-search');
    // It is a QUESTION, not a refusal: nothing about the machine is wrong.
    expect(missing.blocking).toEqual([]);

    // The same world with a key in the vault.
    expect(run(happyWorld()).needsInput).toEqual([]);
  });

  it('is satisfied by the BINDING the install would write, not by any key', () => {
    // A vault holding only `providers/exa/work`: the tool's default ref is
    // unset, so with no binding the requirement is open...
    const world = { ...happyWorld(), secretStatus: searchKeys('work') };
    expect(run(world).needsInput.find((r) => r.kind === 'credential')).toBeDefined();

    // ...and picking that key closes it, because the install writes the
    // binding that makes the tool resolve it.
    const bound = run(world, FILLED, morningBriefing, {
      web_search: { provider: 'exa', secret: 'work' },
    });
    expect(bound.needsInput).toEqual([]);
  });

  it('keeps the row open for a binding that names a key the vault does not hold', () => {
    // The default key IS set, so "some key exists" would read as satisfied —
    // but the binding would send the tool to a ref that resolves to nothing.
    const report = run(happyWorld(), FILLED, morningBriefing, {
      web_search: { provider: 'exa', secret: 'typo' },
    });
    expect(report.needsInput.find((r) => r.kind === 'credential')).toBeDefined();
  });

  it('warns rather than blocking when it cannot tell whether a key is set', () => {
    // No key store wired, so the service could name no alternatives. A row with
    // no way to clear it is the D14 bug in a different costume.
    const snapshot = happyWorld();
    delete snapshot.secretStatus;
    const report = run(snapshot);
    expect(report.needsInput).toEqual([]);
    expect(codes(report.warnings)).toEqual(['SECRET_STATUS_UNKNOWN']);
  });

  it('says nothing at all for a bundle that declares no credentials', () => {
    const noSecrets: RecipeBundle = {
      ...morningBriefing,
      requires: { ...morningBriefing.requires, secrets: undefined },
    };
    const snapshot = happyWorld();
    delete snapshot.secretStatus;
    const report = run(snapshot, FILLED, noSecrets);
    expect(report.warnings).toEqual([]);
    expect(report.needsInput).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Attach mode — the target is a choice, and it must be a real, writable one
// ---------------------------------------------------------------------------

describe('preflightRecipe — attach mode', () => {
  const VAULT = { vaultPath: '/Users/you/Vault/', consolidationTime: '30 23 * * *' };
  // The shipped Obsidian bundle is `both`; preflight always sees ONE view.
  const obsidianSecondBrain = projectBundle(obsidianBoth, 'attach');

  function attachWorld(): RecipeWorldSnapshot {
    return {
      ...happyWorld(),
      availableTools: [...obsidianSecondBrain.requires.tools],
      deliveryTargets: [],
      secretStatus: {},
      personalities: [{ id: 'writer', soulMd: 'I am Writer.\n', toolset: ['read_file'] }],
    };
  }

  it('asks for a target until one is picked', () => {
    const report = preflightRecipe({
      bundle: obsidianSecondBrain,
      snapshot: attachWorld(),
      inputs: VAULT,
    });
    expect(codes(report.blocking)).toEqual(['PERSONALITY_REQUIRED']);
    expect(report.blocking[0]?.message).toBe('Pick the personality this recipe attaches to.');
    expect(report.willCreate.personality).toEqual({ id: '', isNew: false });
  });

  it('refuses a target that does not exist', () => {
    const report = preflightRecipe({
      bundle: obsidianSecondBrain,
      snapshot: attachWorld(),
      inputs: VAULT,
      personalityId: 'ghost',
    });
    expect(codes(report.blocking)).toEqual(['PERSONALITY_NOT_FOUND']);
    expect(report.blocking[0]?.href).toBe('/personalities');
  });

  it('refuses a built-in target, whose files are read-only', () => {
    const snapshot = attachWorld();
    snapshot.personalities = [{ id: 'writer', soulMd: 'x', toolset: [], builtin: true }];
    const report = preflightRecipe({
      bundle: obsidianSecondBrain,
      snapshot,
      inputs: VAULT,
      personalityId: 'writer',
    });
    expect(codes(report.blocking)).toEqual(['PERSONALITY_READ_ONLY']);
  });

  it('passes an existing target and never claims to create it', () => {
    const report = preflightRecipe({
      bundle: obsidianSecondBrain,
      snapshot: attachWorld(),
      inputs: VAULT,
      personalityId: 'writer',
    });
    expect(report.blocking).toEqual([]);
    expect(report.willCreate.personality).toEqual({ id: 'writer', isNew: false });
    // PERSONALITY_ID_TAKEN is a create-mode collision; an attach WANTS the id taken.
    expect(codes(report.blocking)).not.toContain('PERSONALITY_ID_TAKEN');
  });

  it('says so — without blocking — when the target already carries the section', () => {
    const snapshot = attachWorld();
    const { start, end } = recipeSoulMarkers(obsidianSecondBrain.id);
    snapshot.personalities = [
      { id: 'writer', soulMd: `I am Writer.\n\n${start}\nVault rules.\n${end}\n`, toolset: [] },
    ];
    const report = preflightRecipe({
      bundle: obsidianSecondBrain,
      snapshot,
      inputs: VAULT,
      personalityId: 'writer',
    });
    expect(report.blocking).toEqual([]);
    expect(codes(report.warnings)).toContain('ALREADY_ATTACHED');
  });

  it('leaves the create-mode collision check exactly as it was', () => {
    const report = run({
      ...happyWorld(),
      personalities: [{ id: 'briefer', soulMd: 'Someone else entirely.', toolset: ['read_file'] }],
    });
    expect(codes(report.blocking)).toEqual(['PERSONALITY_ID_TAKEN']);
  });
});

describe('preflightRecipe — a both bundle, projected', () => {
  const VAULT = { vaultPath: '/Users/you/Vault/', consolidationTime: '30 23 * * *' };
  const world = (): RecipeWorldSnapshot => ({
    ...happyWorld(),
    availableTools: [...obsidianBoth.requires.tools],
    deliveryTargets: [],
    secretStatus: {},
    personalities: [{ id: 'writer', soulMd: 'I am Writer.\n', toolset: ['read_file'] }],
  });

  it('runs the create path as create — its own id, no target needed', () => {
    const report = preflightRecipe({
      bundle: projectBundle(obsidianBoth, 'create'),
      snapshot: world(),
      inputs: VAULT,
    });
    expect(report.blocking).toEqual([]);
    expect(report.willCreate.personality).toEqual({ id: 'obsidian-archivist', isNew: true });
  });

  it('runs the attach path as attach — the target is required', () => {
    const report = preflightRecipe({
      bundle: projectBundle(obsidianBoth, 'attach'),
      snapshot: world(),
      inputs: VAULT,
    });
    expect(codes(report.blocking)).toEqual(['PERSONALITY_REQUIRED']);
  });

  it('unknownToolNames reads both halves of the unprojected bundle', () => {
    const known = new Set([...obsidianBoth.requires.tools]);
    expect(unknownToolNames(obsidianBoth, known)).toEqual([]);
    const drifted: RecipeBundle = {
      ...obsidianBoth,
      personality: {
        ...obsidianBoth.personality,
        attach: { ...obsidianBoth.personality.attach, toolset: ['ghost_tool'] },
      },
    };
    expect(unknownToolNames(drifted, known)).toEqual(['ghost_tool']);
  });
});
