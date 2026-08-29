import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WakeImplicitRoutes, WakeRouteRow } from '../WakeRouteRow';
import type { WakeRouteDraft, WakeRouteWire } from '../wake-routes';

// WakeRouteRow is hook-free, so it renders with `renderToStaticMarkup` — the
// apps/web suite has no DOM.

function draft(over: Partial<WakeRouteDraft> = {}): WakeRouteDraft {
  return {
    key: 'k1',
    id: 'r-eng',
    phrase: 'hey engineer',
    personalityId: 'engineer',
    privileged: false,
    enabled: true,
    ...over,
  };
}

function markup(
  over: Partial<WakeRouteDraft> = {},
  props: Partial<{ matched: boolean; error: string | null }> = {},
) {
  return renderToStaticMarkup(
    createElement(WakeRouteRow, {
      draft: draft(over),
      personalities: [
        { id: 'engineer', name: 'Engineer' },
        { id: 'operator', name: 'Operator' },
      ],
      matched: props.matched ?? false,
      error: props.error ?? null,
      disabled: false,
      onChange: () => {},
      onDelete: () => {},
    }),
  );
}

describe('WakeRouteRow', () => {
  it('is a row, never the Card primitive', () => {
    const html = markup();
    expect(html).toContain('wake-route-row');
    expect(html).not.toContain('ant-card');
  });

  it('renders the phrase in the mono field and the personality mark beside it', () => {
    const html = markup();
    expect(html).toContain('wake-route-phrase');
    expect(html).toContain('hey engineer');
    expect(html).toContain('engineer personality'); // PersonalityMark's aria-label
  });

  it('reserves the mark slot before a personality is picked, so choosing one moves nothing', () => {
    expect(markup({ personalityId: '' })).toContain('wake-route-mark-slot');
  });

  it('the privileged switch explains the access-control consequence, not just the word', () => {
    const html = markup();
    // The tooltip title is rendered into the accessible tree by antd.
    expect(html).toContain('anyone in earshot');
    expect(markup({ privileged: true })).toContain(
      'Anyone within earshot can wake this personality.',
    );
  });

  it('lights up in the personality’s own accent when the tester matched it', () => {
    const html = markup({}, { matched: true });
    expect(html).toContain('wake-route-row--matched');
    // engineer's accent, per DESIGN.md's per-personality table.
    expect(html.toLowerCase()).toContain('#4ade80');
  });

  it('shows a server rejection on the offending row', () => {
    const html = markup({}, { error: 'Wake route "r-eng" names unknown personality "ghost".' });
    expect(html).toContain('wake-route-row--error');
    expect(html).toContain('names unknown personality');
  });
});

describe('WakeImplicitRoutes', () => {
  const routes: WakeRouteWire[] = [
    {
      id: 'auto:researcher',
      phrase: 'hey researcher',
      personalityId: 'researcher',
      privileged: false,
      enabled: true,
      implicit: true,
    },
    {
      id: 'auto:coach',
      phrase: 'hey coach',
      personalityId: 'coach',
      privileged: false,
      enabled: true,
      implicit: true,
    },
  ];

  function implicitMarkup(matchedKey: string | null = null) {
    return renderToStaticMarkup(createElement(WakeImplicitRoutes, { routes, matchedKey }));
  }

  it('renders nothing when every personality already has a configured route', () => {
    expect(
      renderToStaticMarkup(createElement(WakeImplicitRoutes, { routes: [], matchedKey: null })),
    ).toBe('');
  });

  it('names which agent answers each default, not just the phrase', () => {
    const html = implicitMarkup();
    expect(html).toContain('hey researcher');
    expect(html).toContain('researcher personality'); // PersonalityMark's aria-label
    expect(html).toContain('coach personality');
    expect(html).toContain('Privileged personalities are left off this list');
  });

  it('lights a matched default in that personality’s own accent, in the row’s vocabulary', () => {
    const html = implicitMarkup('auto:researcher');
    expect(html).toContain('wake-implicit-route--matched');
    // researcher's accent, per DESIGN.md's per-personality table.
    expect(html.toLowerCase()).toContain('#4a9eff');
  });

  it('lights only the default the tester heard', () => {
    const matched = implicitMarkup('auto:coach').match(/wake-implicit-route--matched/g) ?? [];
    expect(matched).toHaveLength(1);
  });
});
