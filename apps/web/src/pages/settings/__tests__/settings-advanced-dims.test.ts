import { Form } from 'antd';
import { type ComponentType, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ADVANCED_DIM_CLASS } from '../components/advanced';
import type { SettingsPaneContext } from '../pane-context';
import { ChatPane } from '../panes/chat';
import { DataPane } from '../panes/data';
import { JobsPane } from '../panes/jobs';

// T8 — plan/phases/settings-navigation.md D10. Advanced DIMS; it never unmounts.
//
// The regression this exists to catch is a return to `{showAdvanced && …}`,
// which is what the page did before and which had two costs. The small one:
// unmounted fields survive only because `preserve` is on, so layout was leaning
// on a form mechanism. The large one: Background jobs and Data & retention are
// advanced end to end, so with the toggle off they rendered rail rows you could
// click into and find EMPTY.
//
// The second half of the assertion matters as much as the first: dimmed and
// still interactive. A control you can see and cannot touch is a trap, not a
// hint, so no `disabled` may appear inside a dimmed block.
//
// `renderToStaticMarkup`, same precedent as
// `features/voice/__tests__/call-stage.test.ts` — `apps/web` has no jsdom and
// this change deliberately adds none.

function noop() {}

/**
 * Stands in for `SettingsShell`: it owns the form instance and hands the pane
 * its context through the outlet, which is the only way a pane ever gets one.
 */
function Harness({ showAdvanced }: { showAdvanced: boolean }) {
  const [form] = Form.useForm();
  const context: SettingsPaneContext = {
    form,
    config: undefined,
    personalities: [],
    personalitiesLoading: false,
    showAdvanced,
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

function markup(pane: ComponentType, showAdvanced: boolean): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: ['/'] },
      createElement(
        Routes,
        null,
        createElement(
          Route,
          { element: createElement(Harness, { showAdvanced }) },
          createElement(Route, { path: '/', element: createElement(pane) }),
        ),
      ),
    ),
  );
}

/**
 * Exactly the first dimmed block and nothing after it, by `<div>` depth — so
 * an attribute found inside it really is inside it.
 */
function dimmedBlock(html: string): string {
  const marker = html.indexOf(ADVANCED_DIM_CLASS);
  expect(marker, 'no dimmed block in the markup').toBeGreaterThan(-1);
  const start = html.lastIndexOf('<div', marker);
  let depth = 0;
  for (let i = start; i < html.length; i += 1) {
    if (html.startsWith('<div', i)) depth += 1;
    else if (html.startsWith('</div>', i)) {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 6);
    }
  }
  throw new Error('unterminated dimmed block');
}

describe('advanced controls with the toggle OFF', () => {
  const html = markup(ChatPane, false);

  it('still renders the input — dimmed, not unmounted', () => {
    expect(html).toContain(ADVANCED_DIM_CLASS);
    expect(html).toContain('id="displayToolPreviewLength"');
  });

  it('renders the input INSIDE the dimmed block', () => {
    expect(dimmedBlock(html)).toContain('id="displayToolPreviewLength"');
  });

  it('leaves it interactive: nothing in the dimmed block is disabled', () => {
    // Dimming is opacity and nothing else. `disabled`, `aria-disabled`, `inert`
    // and `pointer-events: none` each turn the hint into a trap.
    //
    // Matched as ATTRIBUTES, not substrings: antd's own InputNumber steppers
    // ship `aria-disabled="false"` and its Select ships `readOnly` on the
    // combobox input, and neither is anything this change did.
    const block = dimmedBlock(html);
    expect(block).not.toMatch(/\sdisabled(=|\s|\/|>)/);
    expect(block).not.toContain('aria-disabled="true"');
    expect(block).not.toMatch(/\sinert(=|\s|\/|>)/);
    expect(block).not.toContain('pointer-events');
  });

  it('renders the non-advanced controls undimmed, so the toggle still says something', () => {
    expect(html).toContain('id="displayVerbosity"');
    expect(html.indexOf('id="displayVerbosity"')).toBeLessThan(html.indexOf(ADVANCED_DIM_CLASS));
  });
});

describe('advanced controls with the toggle ON', () => {
  const html = markup(ChatPane, true);

  it('renders the same input without the dim class', () => {
    expect(html).toContain('id="displayToolPreviewLength"');
    expect(html).not.toContain(ADVANCED_DIM_CLASS);
  });
});

describe('the two categories that are advanced end to end', () => {
  // Before D10 these rendered `null` with the toggle off — a rail row you could
  // navigate to and find blank, which is worse than one you cannot reach.
  it('Background jobs renders its controls with the toggle off', () => {
    const html = markup(JobsPane, false);
    expect(html).toContain(ADVANCED_DIM_CLASS);
    expect(html).toContain('id="background_maxConcurrentJobs"');
  });

  it('Data & retention renders its editor with the toggle off', () => {
    const html = markup(DataPane, false);
    expect(html).toContain(ADVANCED_DIM_CLASS);
    expect(html).toContain('Add retention rule');
  });
});
