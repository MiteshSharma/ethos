import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEY_CATEGORY_IDS } from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Form } from 'antd';
import { type ComponentType, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { vaultKeyKeys } from '../../../features/settings/api/keys';
import { WakePanel } from '../../../features/voice/WakePanel';
import { SETTINGS_INDEX } from '../lib/settings-index';
import type { SettingsPaneContext } from '../pane-context';
import { GeneralPane } from '../panes/general';
import { KeysPane } from '../panes/keys';
import { SecurityPane } from '../panes/security';

// T10 — plan/phases/settings-navigation.md D11 / §6.4. Every `SETTINGS_INDEX`
// entry with `saves: 'self'` must render `SelfSaveMarker` somewhere on
// screen.
//
// `SelfSaveMarker` is placed once per distinct UI AREA, not once per index
// entry — several entries describe one control (the four create-API-key-modal
// fields are one modal; the six Desktop-connection entries are one card), so
// this test is designed at (category, section) granularity: for every pair
// that holds at least one self-saving entry, the pane that renders it must
// contain the marker's text at least once, and — where a pane covers more
// than one such section (`SecurityPane`) — once PER section, checked by
// slicing the rendered markup between consecutive `SectionHeading`s so a
// marker deleted from one section cannot hide behind one left on another.
//
// `renderToStaticMarkup`, same technique as `settings-advanced-dims.test.ts`
// (T8) — `apps/web` has no jsdom and this change deliberately does not add
// one. `GeneralPane` and `SecurityPane` need the `SettingsPaneContext` a real
// `SettingsShell` would hand them through the outlet (T8's `Harness`,
// verbatim); `SecurityPane` and `WakePanel` also touch `@tanstack/react-query`
// hooks (named secrets, API keys, A2A, wake routes), so both need a
// `QueryClientProvider` — same pattern as
// `components/personality/__tests__/personality-voice-fields.test.ts`.
//
// `DesktopSettings.tsx` is source-text only: it reaches the Electron `bridge`
// global, which no test in this suite mocks (`settings-no-card.test.ts`,
// `desktop-retention-bounds.test.ts` and `settings-label-collisions.test.ts`
// all read it as text for the same reason) — building that mock is
// disproportionate test infrastructure for four marker placements, per the
// brief's own escape hatch.

const MARKER_TEXT = 'saves on its own';

function noop() {}

/** Stands in for `SettingsShell` — see `settings-advanced-dims.test.ts`. */
function Harness() {
  const [form] = Form.useForm();
  const context: SettingsPaneContext = {
    form,
    config: undefined,
    personalities: [],
    personalitiesLoading: false,
    providerRows: [],
    addProviderRow: noop,
    updateProviderRow: noop,
    moveProviderRow: noop,
    removeProviderRow: noop,
    quickCommandRows: [],
    setQuickCommandRows: noop,
    channelToolsetRows: [],
    setChannelToolsetRows: noop,
    voiceTtsProviderRows: [],
    setVoiceTtsProviderRows: noop,
    voiceSttProviderRows: [],
    setVoiceSttProviderRows: noop,
    voiceRealtimeProviderRows: [],
    setVoiceRealtimeProviderRows: noop,
    retentionRows: [],
    setRetentionRows: noop,
    voiceBotRows: [],
    setVoiceBotRows: noop,
  };
  return createElement(
    Form,
    { form, layout: 'vertical', component: false },
    createElement(Outlet, { context }),
  );
}

/** `WebSearchDefaultsSection` renders nothing at all — not even its own
 *  marker — until `toolSettings.schemas` resolves and names a `web_search`
 *  tool; seeded so the section actually mounts instead of bailing out via its
 *  `if (!schema) return null`. Harmless for panes that never read this key. */
function seedToolSettingsSchema(queryClient: QueryClient): void {
  queryClient.setQueryData(['toolSettings', 'schemas'], {
    tools: [{ name: 'web_search', settingsSchema: { fields: [] } }],
  });
}

function markup(pane: ComponentType): string {
  const queryClient = new QueryClient();
  seedToolSettingsSchema(queryClient);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        MemoryRouter,
        { initialEntries: ['/'] },
        createElement(
          Routes,
          null,
          createElement(
            Route,
            { element: createElement(Harness) },
            createElement(Route, { path: '/', element: createElement(pane) }),
          ),
        ),
      ),
    ),
  );
}

/**
 * The Keys pane renders NOTHING until `rpc.keys.list()` resolves — its
 * sections are the categories the vault actually holds, not a fixed list — so
 * the response is seeded, the same way `seedToolSettingsSchema` seeds the
 * web-search section into existence. It needs no `SettingsPaneContext`: every
 * row saves through its own RPC and none is a `Form.Item`.
 *
 * The seed is built from `KEY_CATEGORY_IDS`, the one canonical category list
 * (`@ethosagent/web-contracts`), so this test cannot fall behind the taxonomy
 * or the service — a new category shows up here automatically.
 */
function keysPaneMarkup(): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(vaultKeyKeys.all(), {
    categories: KEY_CATEGORY_IDS.map((id) => ({
      id,
      // `connections` holds `blob` entries, which the pane routes to
      // `ConnectionRow` — no editor, but the section marker must still render.
      entries: [id === 'connections' ? blobEntryView(id) : entryView(id)],
    })),
  });
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(KeysPane)),
  );
}

function entryView(category: string) {
  const label = `${category} key`;
  return {
    id: `${category}.example`,
    category,
    label,
    shape: 'single' as const,
    fields: [
      { key: 'apiKey', label, ref: `${category}/example/apiKey`, preview: '<unset>', set: false },
    ],
    set: false,
    canSet: true,
    canClear: true,
  };
}

function blobEntryView(category: string) {
  return {
    id: `${category}.codex`,
    category,
    label: 'Codex (ChatGPT sign-in)',
    shape: 'blob' as const,
    fields: [],
    set: false,
    canSet: false,
    canClear: true,
  };
}

function wakePanelMarkup(): string {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(WakePanel)),
  );
}

/** The slice of rendered markup between one `SectionHeading id="…"` and the next. */
function sectionBlock(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  expect(start, `no SectionHeading with id="${id}"`).toBeGreaterThan(-1);
  const afterOpenTag = html.indexOf('>', start) + 1;
  const nextHeading = html.indexOf('settings-section-heading', afterOpenTag);
  return html.slice(afterOpenTag, nextHeading === -1 ? html.length : nextHeading);
}

const SELF_SAVE_PAIRS = Array.from(
  new Set(
    SETTINGS_INDEX.filter((e) => e.saves === 'self').map((e) => `${e.category}/${e.section}`),
  ),
).sort();

// The full set found in the index, kept explicit so this test fails — loudly,
// by name — the moment `SETTINGS_INDEX` grows a `saves: 'self'` entry in a
// section nobody added a marker (or a describe block) for. T6 would not catch
// this: it only knows about `Form.Item` names, and self-save UI areas are, by
// definition, not one.
describe('SETTINGS_INDEX self-saving sections match what this test covers', () => {
  it('is exactly the known (category, section) pairs', () => {
    expect(SELF_SAVE_PAIRS).toEqual([
      'desktop/connection',
      'desktop/keychain-and-auth',
      'desktop/retention',
      'desktop/storage',
      'general/onboarding',
      // Derived, not listed: the Keys pane has one self-saving section per
      // canonical category.
      ...[...KEY_CATEGORY_IDS].map((id) => `keys/${id}`).sort(),
      'security/a2a',
      'security/api-keys',
      'security/named-secrets',
      'security/web-search-defaults',
      'voice/wake-routes',
    ]);
  });
});

describe('every self-saving section renders SelfSaveMarker', () => {
  it('general/onboarding — the setup-wizard button', () => {
    expect(markup(GeneralPane)).toContain(MARKER_TEXT);
  });

  it('voice/wake-routes — WakePanel', () => {
    expect(wakePanelMarkup()).toContain(MARKER_TEXT);
  });

  describe('security — SecurityPane, checked per section', () => {
    const html = markup(SecurityPane);

    it.each(['named-secrets', 'web-search-defaults', 'api-keys', 'a2a'])('%s', (id) => {
      expect(sectionBlock(html, id)).toContain(MARKER_TEXT);
    });
  });

  describe('keys — KeysPane, checked per section', () => {
    const html = keysPaneMarkup();

    it.each([...KEY_CATEGORY_IDS])('%s', (id) => {
      expect(sectionBlock(html, id)).toContain(MARKER_TEXT);
    });
  });

  describe('desktop — DesktopSettings.tsx, source-text', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', '..', 'DesktopSettings.tsx'),
      'utf8',
    );

    it.each(['connection', 'storage', 'retention', 'keychain-and-auth'])('%s', (id) => {
      const headingIndex = source.indexOf(`id="${id}"`);
      expect(headingIndex, `no SectionHeading id="${id}"`).toBeGreaterThan(-1);
      const nextHeadingIndex = source.indexOf('<SectionHeading', headingIndex + 1);
      const block = source.slice(
        headingIndex,
        nextHeadingIndex === -1 ? source.length : nextHeadingIndex,
      );
      expect(block).toContain('<SelfSaveMarker');
    });
  });
});
