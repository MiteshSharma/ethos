// The Keys-pane categories, as the web app needs them.
//
// The LIST and its order are canonical in `@ethosagent/web-contracts`
// (`KEY_CATEGORY_IDS`) — the same definition the contract enum, the web-api
// catalog's `KeyCategory` and `KeysService`'s emit order derive from. This file
// adds the one thing the wire format has no business carrying: how each
// category is presented. It is a `Record<KeyCategoryId, …>`, so adding a
// category upstream fails to compile here until it is given its strings, and
// the taxonomy, the settings index and the pane all read it rather than
// re-listing the categories.

import { KEY_CATEGORY_IDS, type KeyCategoryId } from '@ethosagent/web-contracts';

export interface KeyCategoryPresentation {
  /** Section label in the settings rail, and the heading on the pane. */
  label: string;
  /** The `SETTINGS_INDEX` entry's label — what search and the counts show. */
  indexLabel: string;
  /** One line under the section heading. */
  blurb: string;
}

const PRESENTATION: Record<KeyCategoryId, KeyCategoryPresentation> = {
  tools: {
    label: 'tools',
    indexLabel: 'Tool provider keys',
    blurb:
      'Credentials the tools use. Exa, Tavily and Brave are shown here as they are stored; edit them under Security & access, which owns them.',
  },
  voice: {
    label: 'voice',
    indexLabel: 'Voice provider and transport keys',
    blurb:
      'Provider keys for the speech rosters, plus the LiveKit and SIP-trunk transport credentials.',
  },
  gateway: {
    label: 'gateway',
    indexLabel: 'Channel bot tokens and signing secrets',
    blurb: 'Bot tokens and signing secrets for the channels the gateway serves.',
  },
  settings: {
    label: 'settings',
    indexLabel: 'Machine-wide service keys',
    blurb:
      'Keys behind auxiliary models, telemetry export and the lifecycle hooks — set once for the machine.',
  },
  connections: {
    label: 'connections',
    indexLabel: 'Authorized accounts',
    blurb:
      'Authorized accounts. Issued by a sign-in flow rather than typed in, so they disconnect rather than clear.',
  },
  custom: {
    label: 'custom',
    indexLabel: 'Unrecognized vault keys',
    blurb:
      'Everything else in the vault: keys written by a plugin, by the CLI, or by hand. Nothing is hidden from this page.',
  },
};

/** Every Keys category, in canonical order, with its presentation strings. */
export const KEY_CATEGORIES: readonly ({ id: KeyCategoryId } & KeyCategoryPresentation)[] =
  KEY_CATEGORY_IDS.map((id) => ({ id, ...PRESENTATION[id] }));

/** The heading and blurb for one category, by id. */
export function keyCategoryPresentation(id: string): KeyCategoryPresentation | undefined {
  return id in PRESENTATION ? PRESENTATION[id as KeyCategoryId] : undefined;
}
