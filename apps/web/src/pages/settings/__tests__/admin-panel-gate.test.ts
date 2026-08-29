import { Form } from 'antd';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AdminPanelGate } from '../panes/security';

// T16 — plan/phases/settings-navigation.md §8.g, fixed in Phase 4.
//
// The defect: `Settings.tsx:3379`/`:3383` both read `configQuery.data?.adminEnabled`
// — the SAVED value — for both the button's visibility AND the checkbox's own
// margin, while the checkbox itself writes the FORM store. Ticking the box did
// nothing visible until Save + refetch.
//
// The wrong fix: react to the LIVE value alone (`Form.useWatch`/`shouldUpdate`).
// That shows the button the instant the box is ticked, and the button navigates
// to `/admin` — but the server gate (`admin.service.ts:18` →
// `ConfigService.adminEnabled()` → `config.service.ts:1672`–`:1674`) reads
// `admin.enabled` from the CONFIG FILE, not the browser's form store. A
// live-value button is a button that 403s.
//
// The fix: two independent reads. The button follows the SAVED value — it is
// present exactly when the server would honour it. The LIVE value is
// acknowledged immediately, honestly, via a note rather than a button.
//
// Static markup, same technique as `settings-advanced-dims.test.ts` (T8) and
// `features/voice/__tests__/call-stage.test.ts` — `apps/web` has no jsdom and
// this change deliberately adds none.

function markup(liveEnabled: boolean, savedEnabled: boolean | undefined): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: ['/'] },
      createElement(
        Form,
        { component: false, initialValues: { adminEnabled: liveEnabled } },
        createElement(AdminPanelGate, { savedEnabled }),
      ),
    ),
  );
}

describe('the admin-enable row (§8.g)', () => {
  it('live ✓ / saved ✓ renders the Open admin panel button', () => {
    const html = markup(true, true);
    expect(html).toContain('>Open admin panel<');
    expect(html).not.toContain('Save to enable');
    expect(html).not.toContain('Still enabled until you save');
  });

  it('live ✓ / saved ✗ renders the two-step note, and NO button', () => {
    // This is the state a naive "react to the live value" fix gets wrong: it
    // would show the button here, and the button would 403.
    const html = markup(true, false);
    expect(html).not.toContain('Open admin panel');
    expect(html).toContain('Save to enable, then open the admin panel.');
    expect(html).not.toContain('Still enabled until you save');
  });

  it('live ✗ / saved ✓ renders the still-enabled note, and NO button', () => {
    // This is the state today's defect gets wrong: the box was just unticked,
    // but the server still honours the panel until Save, and the row should
    // say so rather than silently matching the (stale) unticked box.
    const html = markup(false, true);
    expect(html).not.toContain('Open admin panel');
    expect(html).toContain('Still enabled until you save — the panel is reachable.');
    expect(html).not.toContain('Save to enable');
  });

  it("live ✗ / saved ✗ renders neither note nor button — today's baseline off state", () => {
    const html = markup(false, false);
    expect(html).not.toContain('Open admin panel');
    expect(html).not.toContain('Save to enable');
    expect(html).not.toContain('Still enabled until you save');
  });
});
