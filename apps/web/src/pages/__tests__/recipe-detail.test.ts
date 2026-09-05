// @vitest-environment jsdom
//
// The recipe install walk (plan/phases/recipes-gallery.md §5): detail →
// needs-you → confirm → post-install, driven against the real components.
//
// Four behaviours the plan is explicit about are asserted here:
//   • preflight is re-called as the user fills the form in, and the "still
//     needed from you" rows disappear as they are satisfied;
//   • a blocking row disables the install, a warning never does;
//   • the delivery picker offers ONLY server-resolved targets, and picking one
//     writes both the structured `deliverTo` and the `chatTarget` input text;
//   • `RECIPE_STALE` gets a re-preview path, and an `ok: false` report draws
//     rolled-back objects (gone, nothing owed) apart from orphaned ones (still
//     on the machine, only a human can remove them).

import type {
  RecipeBundleWire,
  RecipeInstallReport,
  RecipePreflight,
} from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const navigateFn = vi.fn();

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'morning-briefing' }),
  useNavigate: () => navigateFn,
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) =>
    createElement('a', { href: to, className }, children),
}));

const getFn = vi.fn();
const preflightFn = vi.fn();
const installFn = vi.fn();
const deliveryTargetsFn = vi.fn();

const listFn = vi.fn();
const personalitiesListFn = vi.fn();

vi.mock('../../rpc', () => ({
  rpc: {
    recipes: {
      list: (...args: unknown[]) => listFn(...args),
      get: (...args: unknown[]) => getFn(...args),
      preflight: (...args: unknown[]) => preflightFn(...args),
      install: (...args: unknown[]) => installFn(...args),
    },
    cron: {
      deliveryTargets: (...args: unknown[]) => deliveryTargetsFn(...args),
    },
    personalities: {
      list: (...args: unknown[]) => personalitiesListFn(...args),
    },
  },
}));

const { RecipeDetail } = await import('../RecipeDetail');
const { RecipeInstallPanel } = await import('../../components/recipes/RecipeInstallPanel');

// --- fixtures --------------------------------------------------------------

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
    mcpServers: [],
    plugins: [],
    channels: [{ platform: 'telegram', why: 'Delivery.', deliversCron: true }],
    tools: ['web_search'],
    inputs: [
      { key: 'city', label: 'Your city', kind: 'text', required: true, help: 'For the weather.' },
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
        help: 'Which chat receives it.',
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
  examplePrompts: ['Give me my briefing.'],
  notes: ['Schedules run in the server local timezone.'],
  postInstall: [],
};

/** No channel delivery, no chatTarget — the short path to the confirm step. */
const SIMPLE_BUNDLE: RecipeBundleWire = {
  ...BUNDLE,
  requires: { ...BUNDLE.requires, channels: [], inputs: [] },
  cronJobs: [{ name: 'digest', schedule: '20 6 * * *', prompt: 'Do it.', deliverTo: 'inApp' }],
};

/**
 * An attach recipe: lands on a personality the user picks, with one path
 * input. Served under BUNDLE's route id, since the mocked `useParams` is fixed.
 */
const ATTACH_BUNDLE: RecipeBundleWire = {
  ...BUNDLE,
  title: 'Obsidian second brain',
  personality: {
    mode: 'attach',
    soulSection: 'Vault: {{input.vaultPath}}',
    toolset: ['read_file'],
  },
  requires: {
    ...BUNDLE.requires,
    channels: [],
    tools: ['read_file'],
    inputs: [
      {
        key: 'vaultPath',
        label: 'Vault folder',
        kind: 'path',
        required: true,
        help: 'Absolute path to the vault root.',
      },
    ],
  },
  cronJobs: [],
};

/** The same recipe offered both ways: Archivist, or a personality of yours. */
const BOTH_BUNDLE: RecipeBundleWire = {
  ...ATTACH_BUNDLE,
  personality: {
    mode: 'both',
    id: 'obsidian-archivist',
    name: 'Archivist',
    description: 'Vault librarian.',
    soulMd: 'I am Archivist. Vault: {{input.vaultPath}}',
    toolset: ['read_file'],
    attach: { soulSection: 'Vault: {{input.vaultPath}}', toolset: ['read_file'] },
  },
};

/** Two writable personalities, one with a working directory, plus a built-in. */
const PERSONALITIES = {
  items: [
    { id: 'writer', name: 'Writer', builtin: false, fs_reach: { workdir: ['/Users/you/Notes'] } },
    { id: 'coder', name: 'Coder', builtin: false, fs_reach: null },
    { id: 'assistant', name: 'Assistant', builtin: true, fs_reach: null },
  ],
  nextCursor: null,
  defaultId: 'writer',
};

const TARGETS = [
  {
    platform: 'telegram',
    botKey: 'bot-abc',
    botLabel: '@briefer_bot',
    chatId: '4242',
    label: 'Mitesh',
    source: 'owner' as const,
  },
  {
    platform: 'telegram',
    botKey: 'bot-abc',
    botLabel: '@briefer_bot',
    chatId: '99',
    label: 'Standup',
    source: 'observed' as const,
  },
];

function report(over: Partial<RecipePreflight> = {}): RecipePreflight {
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
    characterSheet: '# Briefer\n\nRouting: claude-sonnet-4-6',
    postInstall: [],
    ...over,
  };
}

/** Stands in for the server: the needsInput list shrinks as answers arrive. */
function preflightLikeServer(input: { inputs?: Record<string, string> }): Promise<RecipePreflight> {
  const inputs = input.inputs ?? {};
  const needsInput: RecipePreflight['needsInput'] = [];
  if (!inputs.city) {
    needsInput.push({ key: 'city', label: 'Your city', kind: 'text', help: 'For the weather.' });
  }
  if (!inputs.chatTarget) {
    needsInput.push({
      key: 'chatTarget',
      label: 'Deliver to',
      kind: 'chatTarget',
      help: 'Which chat receives it.',
    });
  }
  return Promise.resolve(report({ needsInput }));
}

// --- harness ---------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Past the preflight debounce, then let the refetch settle. */
async function settleDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 320));
  });
  await flush();
}

async function mountElement(element: ReactElement): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, element));
  });
  await flush();
}

const mount = () => mountElement(createElement(RecipeDetail));

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((el) =>
    el.textContent?.includes(label),
  );
  if (!found) throw new Error(`No button matching "${label}". Saw: ${container.textContent}`);
  return found;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await flush();
}

async function type(inputId: string, value: string): Promise<void> {
  const el = container.querySelector<HTMLInputElement>(`#${inputId}`);
  if (!el) throw new Error(`No input #${inputId}`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

/**
 * The text of the "Needs you" group only.
 *
 * The group moved and was renamed when the flow was restyled: preflight is now
 * split into Ready / Needs you / Optional (the mock's three labelled groups),
 * and the unanswered-input rows live in the middle one. Same rows, same
 * shrinking behaviour — only the heading changed.
 */
function needsYouText(): string {
  const section = [...container.querySelectorAll('section.recipe-section')].find((el) =>
    el.textContent?.startsWith('Needs you'),
  );
  return section?.textContent ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  getFn.mockResolvedValue({ recipe: BUNDLE });
  listFn.mockResolvedValue({ recipes: [] });
  personalitiesListFn.mockResolvedValue(PERSONALITIES);
  preflightFn.mockImplementation(preflightLikeServer);
  deliveryTargetsFn.mockResolvedValue({ targets: TARGETS });
  installFn.mockResolvedValue({
    ok: true,
    created: {
      personality: 'briefer',
      channelBot: null,
      cronJobs: ['morning briefing'],
      mcpAttachments: [],
    },
    skipped: [],
    rolledBack: [],
    orphaned: [],
    failure: null,
    remaining: [],
    starterPrompt: 'Give me my briefing.',
  } satisfies RecipeInstallReport);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('RecipeDetail — the walk', () => {
  it('shows what the recipe does, then the form, then the character sheet', async () => {
    await mount();

    expect(container.textContent).toContain('Morning briefing');
    expect(container.textContent).toContain('Concise morning-briefing agent.');
    expect(container.textContent).toContain('Schedules run in the server local timezone.');
    // The preview is the server's own character sheet — not a second renderer.
    expect(container.querySelector('.recipe-sheet')?.textContent).toContain(
      'Routing: claude-sonnet-4-6',
    );
    // Nothing is written before the user asks for it.
    expect(installFn).not.toHaveBeenCalled();

    await click(button('Set up Briefer'));
    expect(container.querySelector('#recipe-input-city')).not.toBeNull();
  });

  it('re-runs preflight as inputs are filled, and the still-needed rows disappear', async () => {
    await mount();
    await click(button('Set up Briefer'));

    expect(needsYouText()).toContain('Your city');
    const callsBefore = preflightFn.mock.calls.length;

    await type('recipe-input-city', 'Pune');
    await settleDebounce();

    expect(preflightFn.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(preflightFn).toHaveBeenLastCalledWith({
      id: 'morning-briefing',
      inputs: { units: 'metric', city: 'Pune' },
      // No credential row in this bundle, so nothing is bound.
      secretBindings: {},
    });
    expect(needsYouText()).not.toContain('Your city');
    // The one it has NOT answered is still there.
    expect(needsYouText()).toContain('Deliver to');
  });

  it('offers only server-resolved delivery targets and writes both halves of the choice', async () => {
    await mount();
    await click(button('Set up Briefer'));
    await type('recipe-input-city', 'Pune');
    await settleDebounce();

    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(TARGETS.length);
    expect(container.textContent).toContain('@briefer_bot');
    expect(container.textContent).toContain('your owner chat');
    // No free-text chat id anywhere on the step.
    expect(container.querySelector('#recipe-input-chatTarget')).toBeNull();

    const first = radios[0];
    if (!first) throw new Error('no delivery target rendered');
    await click(first);
    await settleDebounce();

    // The picked target answers the `chatTarget` input, so its row clears.
    expect(preflightFn).toHaveBeenLastCalledWith({
      id: 'morning-briefing',
      inputs: { units: 'metric', city: 'Pune', chatTarget: 'telegram:bot-abc:4242' },
      secretBindings: {},
    });
    expect(needsYouText()).toContain('Nothing — every question is answered.');

    await click(button('Review what gets created'));
    // The button names the outcome, using the RESOLVED schedule.
    await click(button('Create Briefer and its 6:20am job'));

    expect(installFn).toHaveBeenCalledWith({
      id: 'morning-briefing',
      version: 2,
      inputs: { units: 'metric', city: 'Pune', chatTarget: 'telegram:bot-abc:4242' },
      deliverTo: { kind: 'channel', platform: 'telegram', botKey: 'bot-abc', chatId: '4242' },
    });
    expect(container.textContent).toContain('Briefer is installed.');
  });
});

describe('RecipeDetail — blocking versus warnings', () => {
  it('a blocking row disables the install and names the page that fixes it', async () => {
    preflightFn.mockResolvedValue(
      report({
        blocking: [
          {
            code: 'NO_DELIVERY_TARGET',
            message: 'No telegram chat can receive this recipe.',
            action: "Add a telegram bot bound to 'briefer' in Communications.",
            href: '/communications',
          },
        ],
      }),
    );
    await mount();
    await click(button('Set up Briefer'));

    expect(button('Review what gets created').disabled).toBe(true);
    expect(container.textContent).toContain('No telegram chat can receive this recipe.');
    const link = [...container.querySelectorAll('a')].find(
      (el) => el.getAttribute('href') === '/communications',
    );
    expect(link).toBeDefined();
  });

  it('warnings are shown and never block', async () => {
    getFn.mockResolvedValue({ recipe: SIMPLE_BUNDLE });
    preflightFn.mockResolvedValue(
      report({
        warnings: [
          { code: 'MCP_SERVER_OPTIONAL_MISSING', message: 'Optional — it runs without it.' },
          { code: 'GATEWAY_NOT_RUNNING', message: 'The gateway is not running.' },
        ],
      }),
    );
    await mount();

    expect(container.textContent).toContain('Optional — it runs without it.');
    await click(button('Set up Briefer'));
    expect(button('Review what gets created').disabled).toBe(false);
  });
});

describe('RecipeDetail — refusals and partial failures', () => {
  it('a RECIPE_STALE install offers a re-preview instead of retrying', async () => {
    getFn.mockResolvedValue({ recipe: SIMPLE_BUNDLE });
    preflightFn.mockResolvedValue(report());
    installFn.mockRejectedValue(
      Object.assign(new Error("You previewed 'morning-briefing' v2, but v3 is shipped now."), {
        code: 'RECIPE_STALE',
      }),
    );

    await mount();
    await click(button('Set up Briefer'));
    await click(button('Review what gets created'));
    await click(button('Create Briefer'));

    expect(container.textContent).toContain('This recipe changed while you were reading it');
    expect(container.textContent).toContain('but v3 is shipped now');

    const getCalls = getFn.mock.calls.length;
    await click(button('Re-read the recipe'));
    // Back on the detail step, reading the freshly refetched bundle.
    expect(getFn.mock.calls.length).toBeGreaterThan(getCalls);
    expect(container.textContent).not.toContain('This recipe changed while you were reading it');
  });

  it('an ok:false report draws rolled-back and orphaned objects distinctly', async () => {
    const failed: RecipeInstallReport = {
      ok: false,
      created: { personality: null, channelBot: null, cronJobs: [], mcpAttachments: [] },
      skipped: [],
      rolledBack: [{ what: "cron job 'morning briefing'", ok: true }],
      orphaned: [{ what: "personality 'briefer'", href: '/personalities' }],
      failure: {
        code: 'CRON_INVALID',
        message: 'The schedule was rejected by the scheduler.',
        action: 'Fix the schedule and install again.',
      },
      remaining: [
        {
          kind: 'token',
          label: 'Paste a @BotFather token',
          detail: 'Communications → Telegram.',
          href: '/communications',
        },
      ],
      starterPrompt: 'Give me my briefing.',
    };

    await mountElement(
      createElement(RecipeInstallPanel, {
        bundle: BUNDLE,
        report: failed,
        onOpenChat: () => {},
      }),
    );

    const sections = [...container.querySelectorAll('section.recipe-section')].map(
      (el) => el.textContent ?? '',
    );
    const rolledBack = sections.find((text) => text.startsWith('Rolled back'));
    const orphaned = sections.find((text) => text.startsWith('Left behind'));

    expect(rolledBack).toContain("cron job 'morning briefing'");
    expect(rolledBack).toContain('removed');
    expect(orphaned).toContain("personality 'briefer'");
    // The orphan — and only the orphan — carries the page that deletes it.
    expect(rolledBack).not.toContain('/personalities');
    expect(orphaned).toContain('/personalities');

    expect(container.textContent).toContain('The schedule was rejected by the scheduler.');
    expect(container.textContent).toContain('Still on you');
    // Nothing to open a chat with — the personality was rolled back.
    expect([...container.querySelectorAll('button')]).toHaveLength(0);
  });
});

describe('RecipeDetail — the stepper', () => {
  /** The six step labels, in order, whatever element each is rendered as. */
  function stepLabels(): (string | null)[] {
    return [...container.querySelectorAll('.recipe-step')].map((el) => el.textContent);
  }

  function currentStep(): string | undefined {
    return container.querySelector('.recipe-step[aria-current="step"]')?.textContent ?? undefined;
  }

  it('marks where you are and lets you step back into a screen you passed', async () => {
    getFn.mockResolvedValue({ recipe: SIMPLE_BUNDLE });
    preflightFn.mockResolvedValue(report());
    await mount();

    expect(stepLabels()).toEqual([
      '01Recipes',
      '02The recipe',
      '03Needs you',
      '04Preview',
      '05Install',
      '06Working',
    ]);
    expect(currentStep()).toBe('02The recipe');

    await click(button('Set up Briefer'));
    expect(currentStep()).toBe('03Needs you');

    // A step you have passed is a real control; the ones ahead never are, so
    // the tab order cannot land on a step that does nothing.
    const steps = [...container.querySelectorAll('.recipe-step')];
    expect(steps[1]?.tagName).toBe('BUTTON');
    expect(steps[3]?.tagName).toBe('SPAN');
    expect(steps[4]?.tagName).toBe('SPAN');

    const back = steps[1];
    if (!(back instanceof HTMLElement)) throw new Error('no completed step to go back to');
    await click(back);
    expect(currentStep()).toBe('02The recipe');
  });

  it('offers no way back once the install has happened', async () => {
    getFn.mockResolvedValue({ recipe: SIMPLE_BUNDLE });
    preflightFn.mockResolvedValue(report());
    await mount();

    await click(button('Set up Briefer'));
    await click(button('Review what gets created'));
    await click(button('Create Briefer'));

    expect(currentStep()).toBe('06Working');
    // An install has happened; there is no going back to before it.
    expect(
      [...container.querySelectorAll('.recipe-step')].some((el) => el.tagName === 'BUTTON'),
    ).toBe(false);
  });
});

describe('RecipeDetail — attach mode', () => {
  it('offers a personality picker, sends the pick to preflight, and prefills the path from its workdir', async () => {
    getFn.mockResolvedValue({ recipe: ATTACH_BUNDLE });
    preflightFn.mockImplementation((input: { personalityIdOverride?: string }) =>
      Promise.resolve(
        report({
          blocking: input.personalityIdOverride
            ? []
            : [
                {
                  code: 'PERSONALITY_REQUIRED',
                  message: 'Pick the personality this recipe attaches to.',
                  action: 'Choose one of your personalities above.',
                },
              ],
          willCreate: {
            personality: { id: input.personalityIdOverride ?? '', isNew: false },
            cronJobs: [],
            mcpAttachments: [],
          },
        }),
      ),
    );
    await mount();

    // The recipe step says what an attach is, not "Creates personality X".
    expect(container.textContent).toContain('Attaches to a personality you choose');
    expect(container.textContent).not.toContain('Set up ');
    await click(button('Choose a personality'));

    // The picker is the first row; built-ins are not offered.
    const select = container.querySelector('#recipe-attach-target');
    expect(select).not.toBeNull();
    expect(button('Review what gets created').disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('#recipe-input-vaultPath')?.value).toBe('');

    // Open the Antd select and pick Writer.
    const trigger = container.querySelector('.recipe-field-select');
    if (!(trigger instanceof HTMLElement)) throw new Error('no select trigger');
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await flush();
    const options = [...document.querySelectorAll('.ant-select-item-option')].map(
      (el) => el.textContent,
    );
    expect(options).toContain('Writer (writer)');
    expect(options).not.toContain('Assistant (assistant)');
    const writer = [...document.querySelectorAll('.ant-select-item-option')].find(
      (el) => el.textContent === 'Writer (writer)',
    );
    if (!(writer instanceof HTMLElement)) throw new Error('no Writer option');
    await click(writer);
    await settleDebounce();

    // The pick rides on `personalityIdOverride`, and the empty path input took
    // Writer's workdir, normalised with the trailing slash reach needs.
    expect(preflightFn).toHaveBeenLastCalledWith({
      id: 'morning-briefing',
      inputs: { vaultPath: '/Users/you/Notes/' },
      secretBindings: {},
      personalityIdOverride: 'writer',
    });
    expect(container.querySelector<HTMLInputElement>('#recipe-input-vaultPath')?.value).toBe(
      '/Users/you/Notes/',
    );
    expect(button('Review what gets created').disabled).toBe(false);

    await click(button('Review what gets created'));
    // The button names the outcome: an attach, onto the chosen personality.
    await click(button('Attach to Writer'));
    expect(installFn).toHaveBeenCalledWith({
      id: 'morning-briefing',
      version: 2,
      inputs: { vaultPath: '/Users/you/Notes/' },
      personalityIdOverride: 'writer',
    });
  });

  it('keeps a path the user typed when the personality changes', async () => {
    getFn.mockResolvedValue({ recipe: ATTACH_BUNDLE });
    preflightFn.mockResolvedValue(report());
    await mount();
    await click(button('Choose a personality'));
    await type('recipe-input-vaultPath', '/Users/you/Vault/');

    const trigger = container.querySelector('.recipe-field-select');
    if (!(trigger instanceof HTMLElement)) throw new Error('no select trigger');
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await flush();
    const writer = [...document.querySelectorAll('.ant-select-item-option')].find(
      (el) => el.textContent === 'Writer (writer)',
    );
    if (!(writer instanceof HTMLElement)) throw new Error('no Writer option');
    await click(writer);

    expect(container.querySelector<HTMLInputElement>('#recipe-input-vaultPath')?.value).toBe(
      '/Users/you/Vault/',
    );
  });
});

describe('RecipeDetail — a both recipe', () => {
  /** Open the picker and choose Writer. */
  async function pickWriter(): Promise<void> {
    const trigger = container.querySelector('.recipe-field-select');
    if (!(trigger instanceof HTMLElement)) throw new Error('no select trigger');
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await flush();
    const writer = [...document.querySelectorAll('.ant-select-item-option')].find(
      (el) => el.textContent === 'Writer (writer)',
    );
    if (!(writer instanceof HTMLElement)) throw new Error('no Writer option');
    await click(writer);
  }

  it('defaults to create, offers the switch, and only prefills the path in attach mode', async () => {
    getFn.mockResolvedValue({ recipe: BOTH_BUNDLE });
    preflightFn.mockResolvedValue(report());
    await mount();

    expect(container.textContent).toContain(
      'Creates Archivist, or attaches to a personality you choose',
    );
    await click(button('Set up Archivist'));

    // Create is the default: the mode rides on `installMode`, no picker yet.
    expect(container.textContent).toContain('How to install');
    expect(container.querySelector('#recipe-attach-target')).toBeNull();
    await settleDebounce();
    expect(preflightFn).toHaveBeenLastCalledWith({
      id: 'morning-briefing',
      inputs: {},
      secretBindings: {},
      installMode: 'create',
    });

    // Switch to attach: the picker appears, the path is still empty.
    const attachOption = [...container.querySelectorAll('.ant-segmented-item')].find((el) =>
      el.textContent?.includes('Attach to an existing personality'),
    );
    if (!(attachOption instanceof HTMLElement)) throw new Error('no attach option');
    await click(attachOption);
    expect(container.querySelector('#recipe-attach-target')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('#recipe-input-vaultPath')?.value).toBe('');

    await pickWriter();
    await settleDebounce();
    expect(container.querySelector<HTMLInputElement>('#recipe-input-vaultPath')?.value).toBe(
      '/Users/you/Notes/',
    );
    expect(preflightFn).toHaveBeenLastCalledWith({
      id: 'morning-briefing',
      inputs: { vaultPath: '/Users/you/Notes/' },
      secretBindings: {},
      personalityIdOverride: 'writer',
      installMode: 'attach',
    });

    await click(button('Review what gets created'));
    await click(button('Attach to Writer'));
    expect(installFn).toHaveBeenCalledWith({
      id: 'morning-briefing',
      version: 2,
      inputs: { vaultPath: '/Users/you/Notes/' },
      personalityIdOverride: 'writer',
      installMode: 'attach',
    });
  });

  it('installs as create when the switch is left alone', async () => {
    getFn.mockResolvedValue({ recipe: BOTH_BUNDLE });
    preflightFn.mockResolvedValue(report());
    await mount();
    await click(button('Set up Archivist'));
    await type('recipe-input-vaultPath', '/Users/you/Vault/');
    await click(button('Review what gets created'));
    await click(button('Create Archivist'));
    expect(installFn).toHaveBeenCalledWith({
      id: 'morning-briefing',
      version: 2,
      inputs: { vaultPath: '/Users/you/Vault/' },
      installMode: 'create',
    });
  });
});
