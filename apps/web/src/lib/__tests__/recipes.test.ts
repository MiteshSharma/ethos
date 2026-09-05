import type {
  CronDeliveryTarget,
  RecipeBundleWire,
  RecipePreflight,
} from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  chatTargetInputKey,
  chatTargetValue,
  createsRows,
  defaultInputValues,
  deliverToFromTarget,
  describeDailyTime,
  installActionLabel,
  installBlockedReason,
  isStaleRecipeError,
  needsDeliveryTarget,
  prefillPathInputs,
  preflightGroups,
  projectBundle,
  recipeAgentName,
  recipeMetaLine,
  requirementRows,
  resolveInstallMode,
} from '../recipes';

// The rules behind the Recipes UI, without a DOM
// (plan/phases/recipes-gallery.md §5). The load-bearing one is the last
// section: a BLOCKING row stops an install, a WARNING never does.

const BUNDLE: RecipeBundleWire = {
  id: 'morning-briefing',
  version: 2,
  title: 'Morning briefing',
  summary: 'A digest before you wake up.',
  tags: ['daily'],
  personality: {
    mode: 'create',
    id: 'briefer',
    name: 'Briefer',
    description: 'Concise morning-briefing agent.',
    soulMd: 'I am Briefer.',
    toolset: ['web_search'],
  },
  requires: {
    mcpServers: [
      {
        name: 'google-calendar',
        transport: 'stdio',
        auth: 'oauth',
        why: "Adds today's agenda.",
      },
    ],
    plugins: [],
    channels: [{ platform: 'telegram', why: 'Delivery.', deliversCron: true }],
    tools: ['web_search', 'memory_read'],
    inputs: [
      { key: 'city', label: 'Your city', kind: 'text', required: true, help: 'For weather.' },
      {
        key: 'units',
        label: 'Units',
        kind: 'choice',
        required: true,
        default: 'metric',
        options: ['metric', 'imperial'],
        help: 'Temperature units.',
      },
      {
        key: 'chatTarget',
        label: 'Deliver to',
        kind: 'chatTarget',
        required: true,
        help: 'Which chat.',
      },
    ],
  },
  cronJobs: [
    {
      name: 'morning briefing',
      schedule: '{{input.briefingTime}}',
      prompt: 'Assemble it.',
      deliverTo: 'channel',
    },
  ],
  starterPrompt: 'Give me my briefing.',
  examplePrompts: [],
  notes: [],
  postInstall: [],
};

const TARGET: CronDeliveryTarget = {
  platform: 'telegram',
  botKey: 'bot-abc',
  botLabel: '@briefer_bot',
  chatId: '4242',
  label: 'Mitesh',
  source: 'owner',
};

function preflight(over: Partial<RecipePreflight> = {}): RecipePreflight {
  return {
    blocking: [],
    needsInput: [],
    warnings: [],
    willCreate: {
      personality: { id: 'briefer', isNew: true },
      cronJobs: [
        { name: 'morning briefing', schedule: '20 6 * * *', nextRun: null, exists: false },
      ],
      mcpAttachments: [],
    },
    characterSheet: '# Briefer',
    postInstall: [],
    ...over,
  };
}

describe('delivery target', () => {
  it('writes both the structured address and the input text', () => {
    expect(deliverToFromTarget(TARGET)).toEqual({
      kind: 'channel',
      platform: 'telegram',
      botKey: 'bot-abc',
      chatId: '4242',
    });
    expect(chatTargetValue(TARGET)).toBe('telegram:bot-abc:4242');
  });

  it('finds the bundle input the picker answers', () => {
    expect(chatTargetInputKey(BUNDLE)).toBe('chatTarget');
    expect(needsDeliveryTarget(BUNDLE)).toBe(true);
  });

  it('needs no target when no job delivers to a channel', () => {
    expect(needsDeliveryTarget({ ...BUNDLE, cronJobs: [] })).toBe(false);
  });
});

describe('defaultInputValues', () => {
  it('seeds only the inputs that ship a default', () => {
    expect(defaultInputValues(BUNDLE)).toEqual({ units: 'metric' });
  });
});

describe('installBlockedReason', () => {
  it('blocks on a blocking row, carrying its action', () => {
    const reason = installBlockedReason({
      preflight: preflight({
        blocking: [
          {
            code: 'NO_DELIVERY_TARGET',
            message: 'No telegram chat can receive this.',
            action: "Add a telegram bot bound to 'briefer'.",
            href: '/communications',
          },
        ],
      }),
      needsTarget: false,
      hasTarget: true,
    });
    expect(reason).toBe("Add a telegram bot bound to 'briefer'.");
  });

  it('does NOT block on warnings', () => {
    const reason = installBlockedReason({
      preflight: preflight({
        warnings: [
          { code: 'MCP_SERVER_OPTIONAL_MISSING', message: 'Optional — runs without it.' },
          { code: 'PLUGIN_SAFETY_FINDING', message: 'plugin-x: reads the network.' },
          { code: 'GATEWAY_NOT_RUNNING', message: 'The gateway is not running.' },
        ],
      }),
      needsTarget: false,
      hasTarget: true,
    });
    expect(reason).toBeNull();
  });

  it('blocks while an input is still empty, and again until a target is picked', () => {
    expect(
      installBlockedReason({
        preflight: preflight({
          needsInput: [{ key: 'city', label: 'Your city', kind: 'text', help: 'For weather.' }],
        }),
        needsTarget: true,
        hasTarget: false,
      }),
    ).toBe('Your city is still empty.');

    expect(
      installBlockedReason({ preflight: preflight(), needsTarget: true, hasTarget: false }),
    ).toBe('Pick the chat this recipe delivers to.');

    expect(
      installBlockedReason({ preflight: preflight(), needsTarget: true, hasTarget: true }),
    ).toBeNull();
  });

  it('blocks while the report has not arrived', () => {
    expect(
      installBlockedReason({ preflight: undefined, needsTarget: false, hasTarget: false }),
    ).not.toBeNull();
  });
});

describe('requirementRows', () => {
  it('marks each class present or missing from preflight CODES, not its prose', () => {
    const rows = requirementRows(
      BUNDLE,
      preflight({
        blocking: [
          {
            code: 'NO_DELIVERY_TARGET',
            message: 'No telegram chat can receive this.',
            action: 'Add a bot.',
          },
        ],
        willCreate: {
          personality: { id: 'briefer', isNew: true },
          cronJobs: [],
          mcpAttachments: ['google-calendar'],
        },
      }),
    );

    expect(rows.map((row) => [row.label, row.ok])).toEqual([
      ['Tools', true],
      ['MCP server', true],
      ['Delivers on', false],
    ]);
  });

  it('marks an MCP server missing when preflight would not attach it', () => {
    const rows = requirementRows(BUNDLE, preflight());
    expect(rows.find((row) => row.label === 'MCP server')?.ok).toBe(false);
  });
});

describe('describeDailyTime', () => {
  it('names a plain daily time and refuses anything else', () => {
    expect(describeDailyTime('20 6 * * *')).toBe('6:20am');
    expect(describeDailyTime('0 0 * * *')).toBe('12:00am');
    expect(describeDailyTime('30 13 * * *')).toBe('1:30pm');
    expect(describeDailyTime('0 9 * * 1-5')).toBeNull();
    expect(describeDailyTime('*/5 * * * *')).toBeNull();
    expect(describeDailyTime('nonsense')).toBeNull();
  });
});

describe('installActionLabel', () => {
  it('names the outcome, using the RESOLVED schedule', () => {
    expect(installActionLabel(BUNDLE, preflight().willCreate.cronJobs)).toBe(
      'Create Briefer and its 6:20am job',
    );
  });

  it('falls back to the job name for a schedule with no plain time', () => {
    expect(
      installActionLabel(BUNDLE, [
        { name: 'weekday digest', schedule: '0 9 * * 1-5', nextRun: null, exists: false },
      ]),
    ).toBe('Create Briefer and its weekday digest job');
  });

  it('counts when there is more than one, and omits jobs when there are none', () => {
    expect(
      installActionLabel(BUNDLE, [
        { name: 'a', schedule: '20 6 * * *', nextRun: null, exists: false },
        { name: 'b', schedule: '20 7 * * *', nextRun: null, exists: false },
      ]),
    ).toBe('Create Briefer and its 2 jobs');
    expect(installActionLabel(BUNDLE, [])).toBe('Create Briefer');
  });
});

describe('isStaleRecipeError', () => {
  it('recognises the optimistic-concurrency refusal and nothing else', () => {
    expect(isStaleRecipeError({ code: 'RECIPE_STALE' })).toBe(true);
    expect(isStaleRecipeError({ code: 'RECIPE_BLOCKED' })).toBe(false);
    expect(isStaleRecipeError(new Error('boom'))).toBe(false);
    expect(isStaleRecipeError(null)).toBe(false);
  });
});

describe('recipeMetaLine', () => {
  it('names the delivery, the servers and how many answers it wants', () => {
    // `units` ships a default, so it is not one of the questions asked.
    expect(recipeMetaLine(BUNDLE)).toBe('cron → telegram · 1 MCP · 2 questions');
  });

  it('says so when a recipe wires nothing and asks nothing', () => {
    expect(
      recipeMetaLine({
        ...BUNDLE,
        requires: { ...BUNDLE.requires, mcpServers: [], inputs: [] },
        cronJobs: [],
      }),
    ).toBe('no setup needed');
  });

  it('distinguishes the three cron destinations', () => {
    const withJob = (deliverTo: 'inApp' | 'none') => ({
      ...BUNDLE,
      requires: { ...BUNDLE.requires, mcpServers: [], inputs: [] },
      cronJobs: [{ name: 'digest', schedule: '20 6 * * *', prompt: 'Do it.', deliverTo }],
    });
    expect(recipeMetaLine(withJob('inApp'))).toBe('cron → in-app');
    expect(recipeMetaLine(withJob('none'))).toBe('cron → file');
  });
});

describe('preflightGroups', () => {
  it('splits ready from what is still on the user, and never draws a refusal twice', () => {
    const groups = preflightGroups(
      BUNDLE,
      preflight({
        blocking: [
          {
            code: 'TOOL_UNAVAILABLE',
            message: "The 'web_search' tool is not available.",
            action: 'Enable it and re-check.',
            href: '/settings',
          },
        ],
        needsInput: [{ key: 'city', label: 'Your city', kind: 'text', help: 'For weather.' }],
      }),
    );

    // The failing requirement class is NOT repeated as a crossed-out ready
    // row — the blocking row below carries the same fact plus the fix.
    expect(groups.ready.map((row) => row.label)).not.toContain('Tools');
    expect(groups.needsYou.map((row) => row.label)).toEqual([
      "The 'web_search' tool is not available.",
      'Your city',
    ]);
    expect(groups.needsYou[0]?.href).toBe('/settings');
    expect(groups.needsYou[0]?.glyph).toBe('✗');
    expect(groups.needsYou[1]?.glyph).toBe('!');
  });

  it('puts every warning under optional, and warnings alone never reach needs-you', () => {
    const groups = preflightGroups(
      BUNDLE,
      preflight({
        warnings: [{ code: 'MCP_SERVER_OPTIONAL_MISSING', message: 'Optional — runs without it.' }],
      }),
    );

    expect(groups.needsYou).toEqual([]);
    expect(groups.optional.map((row) => row.label)).toEqual(['Optional — runs without it.']);
    expect(groups.optional[0]?.value).toBe('optional');
    // Delivery and tools both check out, so they read as ready.
    expect(groups.ready.map((row) => row.label)).toEqual(['Tools', 'Delivers on']);
  });
});

describe('createsRows', () => {
  it('names the agent, the toolset, each server and each schedule', () => {
    expect(createsRows(BUNDLE).map((row) => [row.label, row.value])).toEqual([
      ['An agent — Briefer', 'briefer'],
      ['1 tool', 'toolset'],
      ['google-calendar', 'oauth'],
      ['Scheduled — morning briefing', '{{input.briefingTime}}'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Attach mode — the target is chosen, and it answers the path inputs
// ---------------------------------------------------------------------------

const ATTACH_BUNDLE: RecipeBundleWire = {
  ...BUNDLE,
  id: 'obsidian-second-brain',
  personality: {
    mode: 'attach',
    soulSection: 'Vault: {{input.vaultPath}}',
    toolset: ['read_file'],
  },
  requires: {
    ...BUNDLE.requires,
    mcpServers: [],
    channels: [],
    inputs: [
      { key: 'vaultPath', label: 'Vault folder', kind: 'path', required: true, help: 'Root.' },
      { key: 'other', label: 'Other', kind: 'text', required: false, help: 'Not a path.' },
    ],
  },
  cronJobs: [],
};

describe('prefillPathInputs', () => {
  it('fills an empty path input from the first workdir, with a trailing slash', () => {
    expect(prefillPathInputs(ATTACH_BUNDLE, {}, ['/Users/you/Notes', '/elsewhere'])).toEqual({
      vaultPath: '/Users/you/Notes/',
    });
    expect(prefillPathInputs(ATTACH_BUNDLE, {}, ['/Users/you/Notes/'])).toEqual({
      vaultPath: '/Users/you/Notes/',
    });
  });

  it('never overwrites a value the user typed, and touches only path inputs', () => {
    const typed = { vaultPath: '/Users/you/Vault/', other: 'x' };
    expect(prefillPathInputs(ATTACH_BUNDLE, typed, ['/Users/you/Notes'])).toEqual(typed);
    expect(prefillPathInputs(ATTACH_BUNDLE, { other: 'x' }, ['/n'])).toEqual({
      vaultPath: '/n/',
      other: 'x',
    });
  });

  it('leaves the field empty when the personality has no workdir', () => {
    expect(prefillPathInputs(ATTACH_BUNDLE, {}, null)).toEqual({});
    expect(prefillPathInputs(ATTACH_BUNDLE, {}, [])).toEqual({});
  });
});

describe('attach-mode copy', () => {
  it('names the chosen personality, or says one is still to be chosen', () => {
    expect(recipeAgentName(BUNDLE)).toBe('Briefer');
    expect(recipeAgentName(ATTACH_BUNDLE)).toBe('the personality you choose');
    expect(recipeAgentName(ATTACH_BUNDLE, 'Writer')).toBe('Writer');
    expect(installActionLabel(ATTACH_BUNDLE, [], 'Writer')).toBe('Attach to Writer');
    expect(
      installActionLabel(
        ATTACH_BUNDLE,
        [{ name: 'vault-consolidation', schedule: '30 23 * * *', nextRun: null, exists: false }],
        'Writer',
      ),
    ).toBe('Attach to Writer and its 11:30pm job');
  });

  it('says what an attach does instead of naming an agent it would create', () => {
    const rows = createsRows(ATTACH_BUNDLE);
    expect(rows[0]?.label).toBe('Attaches to a personality you choose');
    expect(rows[0]?.value).toBe('attach');
    expect(rows[1]?.label).toBe('1 tool added');
  });
});

describe('a both recipe', () => {
  const BOTH_BUNDLE: RecipeBundleWire = {
    ...ATTACH_BUNDLE,
    personality: {
      mode: 'both',
      id: 'obsidian-archivist',
      name: 'Archivist',
      description: 'Vault librarian.',
      soulMd: 'I am Archivist.',
      toolset: ['read_file'],
      attach: { soulSection: 'Vault: {{input.vaultPath}}', toolset: ['read_file'] },
    },
  };

  it('resolves to create by default and to whatever is asked, unlike a single-mode recipe', () => {
    expect(resolveInstallMode(BOTH_BUNDLE)).toBe('create');
    expect(resolveInstallMode(BOTH_BUNDLE, 'attach')).toBe('attach');
    expect(resolveInstallMode(BUNDLE, 'attach')).toBe('create');
    expect(resolveInstallMode(ATTACH_BUNDLE, 'create')).toBe('attach');
  });

  it('projects to one view, and every surface reads that view', () => {
    const create = projectBundle(BOTH_BUNDLE, 'create');
    expect(create.personality.mode).toBe('create');
    expect('attach' in create.personality).toBe(false);
    expect(recipeAgentName(create)).toBe('Archivist');
    expect(installActionLabel(create, [])).toBe('Create Archivist');

    const attach = projectBundle(BOTH_BUNDLE, 'attach');
    expect(attach.personality).toEqual({
      mode: 'attach',
      soulSection: 'Vault: {{input.vaultPath}}',
      toolset: ['read_file'],
    });
    expect(installActionLabel(attach, [], 'Writer')).toBe('Attach to Writer');
    // A single-mode bundle is itself.
    expect(projectBundle(BUNDLE, 'create')).toBe(BUNDLE);
  });

  it('says both things on the recipe step', () => {
    expect(createsRows(BOTH_BUNDLE)[0]?.label).toBe(
      'Creates Archivist, or attaches to a personality you choose',
    );
  });
});
