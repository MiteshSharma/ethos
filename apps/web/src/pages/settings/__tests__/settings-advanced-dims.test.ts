import { Form } from 'antd';
import { type ComponentType, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { SettingsPaneContext } from '../pane-context';
import { ChatPane } from '../panes/chat';
import { DataPane } from '../panes/data';
import { JobsPane } from '../panes/jobs';

// T8 — plan/phases/settings-navigation.md D10 (superseded: the advanced
// toggle and its dim treatment were removed; every control now always
// renders in its normal, fully interactive state).
//
// What this still guards: controls that once lived behind `{showAdvanced &&
// ...}` must never vanish/unmount again. That was the original regression —
// Background jobs and Data & retention are advanced end to end, so with a
// conditional mount they rendered rail rows you could click into and find
// EMPTY. The toggle and its dimming are gone, but "always mounted" is the
// part worth keeping a test for.
//
// `renderToStaticMarkup`, same precedent as
// `features/voice/__tests__/call-stage.test.ts` — `apps/web` has no jsdom and
// this file must not add one.

function noop() {}

/**
 * Stands in for `SettingsShell`: it owns the form instance and hands the pane
 * its context through the outlet, which is the only way a pane ever gets one.
 */
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

function markup(pane: ComponentType): string {
  return renderToStaticMarkup(
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
  );
}

describe('advanced controls', () => {
  it('renders in ChatPane — never unmounted', () => {
    const html = markup(ChatPane);
    expect(html).toContain('id="displayToolPreviewLength"');
    expect(html).toContain('id="displayVerbosity"');
  });
});

describe('the two categories that are advanced end to end', () => {
  // Before D10 these rendered `null` with the toggle off — a rail row you
  // could navigate to and find blank, which is worse than one you cannot
  // reach. There is no toggle now; the point is these always render.
  it('Background jobs renders its controls', () => {
    expect(markup(JobsPane)).toContain('id="background_maxConcurrentJobs"');
  });

  it('Data & retention renders its editor', () => {
    expect(markup(DataPane)).toContain('Add retention rule');
  });
});
