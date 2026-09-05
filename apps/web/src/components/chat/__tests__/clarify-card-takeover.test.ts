// D3 — the `browser_takeover` variant of `ClarifyCard`.
//
// What the panel PROMISES, asserted against the markup it ships (the same
// `renderToStaticMarkup` precedent as `call-stage.test.ts`): the two lines and
// the countdown in the waiting state, one ≥44px primary, and — the part that is
// easy to get wrong — a card that STAYS through all three settled states rather
// than unmounting, each of them a glyph AND a word.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClarifyRequestEvent } from '@ethosagent/web-contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ResolvedClarify } from '../../../lib/clarify-queue';
import { ClarifyCard } from '../ClarifyCard';

const NOW = Date.now();

const TAKEOVER: ClarifyRequestEvent = {
  type: 'clarify.request',
  requestId: 'req-takeover',
  question: 'stuck on a login',
  kind: 'browser_takeover',
  meta: { url: 'https://example.com/login?next=/app', sessionId: 'browser-7' },
  defaultDeadlineAt: new Date(NOW + 15 * 60_000).toISOString(),
};

function render(resolution: ResolvedClarify | null = null): string {
  return renderToStaticMarkup(createElement(ClarifyCard, { request: TAKEOVER, resolution }));
}

function settled(source: ResolvedClarify['source'], afterMs: number): ResolvedClarify {
  return {
    requestId: TAKEOVER.requestId,
    question: TAKEOVER.question,
    answer: null,
    source,
    resolvedAt: Date.now() + afterMs,
  };
}

const css = readFileSync(join(import.meta.dirname, '..', '..', '..', 'styles.css'), 'utf8');

describe('ClarifyCard — browser_takeover, waiting', () => {
  const html = render();

  it('leads with the pause and who is in control', () => {
    expect(html).toContain('Agent paused — you&#x27;re in control of the browser');
  });

  it('shows the URL in mono', () => {
    expect(html).toMatch(
      /class="clarify-takeover-url talk-mono">https:\/\/example\.com\/login\?next=\/app/,
    );
  });

  it('says nothing happens until the browser comes back', () => {
    expect(html).toContain('Nothing happens until you hand back');
  });

  it('draws a mono countdown', () => {
    expect(html).toMatch(/class="clarify-takeover-countdown talk-mono">\d+:\d\d</);
  });

  it('offers Hand back as the one primary action', () => {
    expect(html).toContain('Hand back');
    expect(html).toContain('clarify-takeover-handback');
    // No answer box and no Cancel — a takeover is not a question.
    expect(html).not.toContain('Type your answer');
  });

  it('sizes the primary at or above 44px', () => {
    const block = css.slice(css.indexOf('.clarify-takeover-handback.clarify-takeover-handback'));
    expect(block.slice(0, block.indexOf('}'))).toContain('min-height: 44px');
  });
});

describe('ClarifyCard — browser_takeover, settled', () => {
  // The Call Stage lesson: the panel is still there in every settled state.
  for (const source of ['user', 'timeout-no-default', 'cancel'] as const) {
    it(`keeps the card after ${source}`, () => {
      expect(render(settled(source, 60_000))).toContain('clarify-card-takeover');
    });
  }

  it('handed back — glyph and word, with host and how long it took', () => {
    const html = render(settled('user', 134_000));
    expect(html).toContain('✓');
    expect(html).toContain('handed back · example.com · 2m 14s');
    // The waiting body is gone; the row replaced it in place.
    expect(html).not.toContain('Nothing happens until you hand back');
  });

  it('timed out — glyph and word, naming the window and what the agent did', () => {
    const html = render(settled('timeout-no-default', 15 * 60_000));
    expect(html).toContain('✗');
    expect(html).toContain('no one took over in 15m — the agent reported the blockage');
  });

  it('timed out with a default reads the same', () => {
    expect(render(settled('timeout-default', 15 * 60_000))).toContain(
      'no one took over in 15m — the agent reported the blockage',
    );
  });

  it('cancelled — glyph and word', () => {
    const html = render(settled('cancel', 30_000));
    expect(html).toContain('✗');
    expect(html).toContain('takeover cancelled · example.com');
  });
});

describe('ClarifyCard — an ordinary question is untouched', () => {
  it('still renders the question card when kind is absent', () => {
    const html = renderToStaticMarkup(
      createElement(ClarifyCard, {
        request: {
          type: 'clarify.request',
          requestId: 'req-q',
          question: 'Which database?',
          defaultDeadlineAt: new Date(NOW + 60_000).toISOString(),
        },
      }),
    );
    expect(html).toContain('Which database?');
    expect(html).toContain('Type your answer');
    expect(html).not.toContain('clarify-card-takeover');
  });

  it('and when kind is explicitly question', () => {
    const html = renderToStaticMarkup(
      createElement(ClarifyCard, {
        request: {
          type: 'clarify.request',
          requestId: 'req-q2',
          question: 'Which database?',
          kind: 'question',
          defaultDeadlineAt: new Date(NOW + 60_000).toISOString(),
        },
      }),
    );
    expect(html).not.toContain('clarify-card-takeover');
  });
});
