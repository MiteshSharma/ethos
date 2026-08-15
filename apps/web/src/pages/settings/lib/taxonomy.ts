// The Settings taxonomy — 11 categories in 3 groups, and the sections each one
// holds. plan/phases/settings-navigation.md §4.1, with the two owner amendments
// folded in: `voice / how it talks` leads Voice (it selects pipeline-vs-realtime
// and therefore gates everything under it), and `voice / barge-in` gains a third
// surface, `browser`, for the five `display.voice_*` sliders — the per-section
// split of the Voice pane is Phase 5, so this file only records that the section
// exists.
//
// This is the TAXONOMY only: categories → sections. The per-control index
// (`SETTINGS_INDEX`, D8) that drives search, counts and callouts is Phase 2 and
// deliberately does not live here.

export type SettingsGroup = 'Agent' | 'Channels' | 'Machine';

export interface SettingsSection {
  /** kebab-case, `&` spelled `and`. The `:section` half of the URL. */
  slug: string;
  label: string;
}

export interface SettingsCategory {
  /** kebab-case. The `:category` half of the URL. */
  slug: string;
  label: string;
  group: SettingsGroup;
  /** Never empty — the first entry is where a bare category URL lands. */
  sections: SettingsSection[];
  /**
   * Rendered only in the desktop build. `DesktopSettings` talks to Electron IPC,
   * so the category has nothing to say in a browser and must not appear there.
   */
  desktopOnly?: boolean;
}

function section(slug: string, label: string): SettingsSection {
  return { slug, label };
}

export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  {
    slug: 'general',
    label: 'General',
    group: 'Agent',
    sections: [section('basics', 'basics'), section('onboarding', 'onboarding')],
  },
  {
    slug: 'models',
    label: 'Models & providers',
    group: 'Agent',
    sections: [
      section('provider-chain', 'provider chain'),
      section('catalog-and-backends', 'catalog & backends'),
      section('auxiliary-models', 'auxiliary models'),
      section('per-personality-routing', 'per-personality routing'),
    ],
  },
  {
    slug: 'memory',
    label: 'Memory',
    group: 'Agent',
    sections: [
      section('store', 'store'),
      // `memoryApproval.mode` — whether the agent asks before it REMEMBERS.
      // Security & access / approval mode is `approvalMode`, whether it asks
      // before it ACTS. Different keys, different blast radii; they never merge.
      section('approval', 'approval'),
      section('consolidation', 'consolidation'),
      section('capture', 'capture'),
    ],
  },
  {
    slug: 'chat',
    label: 'Chat & context',
    group: 'Agent',
    sections: [section('display', 'display'), section('context', 'context')],
  },
  {
    slug: 'voice',
    label: 'Voice',
    group: 'Channels',
    sections: [
      // First, because `voice.tier` picks pipeline vs realtime and every section
      // below it is read through that choice.
      section('how-it-talks', 'how it talks'),
      section('speech-to-text', 'speech-to-text'),
      section('text-to-speech', 'text-to-speech'),
      section('realtime', 'realtime'),
      // Three surfaces: call, satellite, and browser — the last carrying the
      // five `display.voice_*` sliders that endpoint in this browser.
      section('barge-in', 'barge-in'),
      section('trunk', 'trunk'),
      section('livekit', 'LiveKit'),
      section('numbers', 'numbers'),
      section('hardening', 'hardening'),
      section('wake-routes', 'wake routes'),
      section('channels-that-speak', 'channels that speak'),
      section('voice-notes', 'voice notes'),
      section('call-appearance', 'call appearance'),
    ],
  },
  {
    slug: 'automation',
    label: 'Automation',
    group: 'Channels',
    sections: [
      section('quick-commands', 'quick commands'),
      section('channel-toolsets', 'channel toolsets'),
      section('scheduled-passes', 'scheduled passes'),
    ],
  },
  {
    slug: 'jobs',
    label: 'Background jobs',
    group: 'Channels',
    sections: [
      section('limits', 'limits'),
      section('budgets', 'budgets'),
      section('lifecycle', 'lifecycle'),
    ],
  },
  {
    slug: 'data',
    label: 'Data & retention',
    group: 'Machine',
    sections: [section('rules', 'rules'), section('built-in-defaults', 'built-in defaults')],
  },
  {
    slug: 'security',
    label: 'Security & access',
    group: 'Machine',
    sections: [
      // First: the most safety-relevant control in the product, and what someone
      // hunting for "stop asking me every time" is actually looking for.
      section('approval-mode', 'approval mode'),
      section('named-secrets', 'named secrets'),
      section('web-search-defaults', 'web-search defaults'),
      section('api-keys', 'API keys'),
      section('a2a', 'A2A'),
    ],
  },
  {
    slug: 'developer',
    label: 'Developer',
    group: 'Machine',
    sections: [
      section('debug', 'debug'),
      section('logs', 'logs'),
      section('escape-hatches', 'escape hatches'),
    ],
  },
  {
    slug: 'desktop',
    label: 'Desktop',
    group: 'Machine',
    desktopOnly: true,
    sections: [
      section('connection', 'connection'),
      section('storage', 'storage'),
      section('retention', 'retention'),
      section('keychain-and-auth', 'keychain & auth'),
    ],
  },
];

export const SETTINGS_GROUPS: readonly SettingsGroup[] = ['Agent', 'Channels', 'Machine'];

/** The categories a given build may address. Desktop is absent on web. */
export function visibleCategories(desktop: boolean): SettingsCategory[] {
  return SETTINGS_CATEGORIES.filter((c) => desktop || !c.desktopOnly);
}

export function findCategory(
  slug: string | undefined,
  categories: readonly SettingsCategory[] = SETTINGS_CATEGORIES,
): SettingsCategory | undefined {
  return categories.find((c) => c.slug === slug);
}

/** The URL a rail row points at: the category's first section. */
export function categoryHref(category: SettingsCategory): string {
  return `/settings/${category.slug}/${category.sections[0]?.slug ?? ''}`;
}
