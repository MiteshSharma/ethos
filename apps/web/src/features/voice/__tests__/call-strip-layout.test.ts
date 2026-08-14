import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TalkModeCallBar, type TalkModeCallBarProps } from '../TalkMode';

// Does the CallStrip actually FIT on a 375px phone (DR5)?
//
// `call-strip-css.test.ts` can only string-match the stylesheet, which says
// nothing about width. Nor can jsdom help: it has no layout engine, so every
// `offsetWidth` it reports is 0. So this suite measures the only way that is
// available without a real browser — it takes the item widths from the
// stylesheet that ships and the item TEXT from the component that ships, and
// adds them up.
//
// It is a model, and it is deliberately a crude one: monospace advance for the
// mono labels, declared box sizes for everything else. What it is good for is
// the question that matters — is the widest state wider than the viewport, and
// is the row allowed to do anything about it — and it fails when someone adds
// an item, lengthens a state word, or drops the wrap rule, none of which a
// substring assertion can see.

const css = readFileSync(join(import.meta.dirname, '..', '..', '..', 'styles.css'), 'utf8');

/** The `@media (max-width: 420px)` block: the phone's overrides. */
const narrowCss = ((): string => {
  const start = css.indexOf('@media (max-width: 420px)');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error('unterminated @media (max-width: 420px)');
})();

function rule(scope: string, selector: string): string {
  const at = scope.indexOf(`${selector} {`);
  expect(at, `missing rule: ${selector}`).toBeGreaterThan(-1);
  return scope.slice(at, scope.indexOf('}', at));
}

function px(scope: string, selector: string, prop: string): number {
  const found = new RegExp(`${prop}:\\s*(-?[\\d.]+)px`).exec(rule(scope, selector));
  expect(found, `missing ${prop} on ${selector}`).not.toBeNull();
  return Number(found?.[1]);
}

/** Column gap of a flex row — `gap: <row> <column>`, or one value for both. */
function columnGap(scope: string, selector: string): number {
  const two = /gap:\s*(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(rule(scope, selector));
  return two ? Number(two[2]) : px(scope, selector, 'gap');
}

/** Horizontal padding out of a `padding: <v> <h>` (or `padding: <v>`) shorthand. */
function paddingX(scope: string, selector: string): number {
  const found = /padding:\s*(-?[\d.]+)(?:px)?(?:\s+(-?[\d.]+)(?:px)?)?/.exec(rule(scope, selector));
  expect(found, `missing padding on ${selector}`).not.toBeNull();
  return Number(found?.[2] ?? found?.[1]);
}

/**
 * Geist Mono advances 0.6em per character, like essentially every monospace
 * face. The model is only ever used on the mono labels, which is why a single
 * constant is honest here.
 */
const MONO_ADVANCE_EM = 0.6;
const monoWidth = (text: string, fontSizePx: number): number =>
  text.length * fontSizePx * MONO_ADVANCE_EM;

/** The visible text of one element, from the markup the component produced. */
function textOf(html: string, className: string): string {
  const found = new RegExp(`<span class="${className}"[^>]*>([^<]*)</span>`).exec(html);
  expect(found, `missing element: ${className}`).not.toBeNull();
  return found?.[1] ?? '';
}

/**
 * The widest state the strip can be in, on the narrowest phone it claims to
 * support: the longest state word (`interrupted — go ahead`), the budget chip
 * beside it — the wind-down survives a barge-in, so the two really do coexist —
 * a caption, and all three controls.
 */
const WIDEST: TalkModeCallBarProps = {
  status: 'interrupted',
  micLevels: [0.2, 0.5, 0.9],
  muted: false,
  error: null,
  onToggleMute: () => {},
  onHangUp: () => {},
  windDown: "That's the spending limit for this call, so I'll stop here.",
  caption: "That's the spending limit for this call, so I'll stop here.",
  tier: 'realtime',
  realtimeProvider: 'openai-realtime',
  realtimeModel: 'gpt-realtime',
  latency: { llmMs: 300, ttsMs: 120, totalMs: 420 },
};

const html = renderToStaticMarkup(createElement(TalkModeCallBar, WIDEST));

const VIEWPORT = 375;
/** What the row actually has to lay out in: the strip's own padding is gone. */
const contentBox = VIEWPORT - 2 * paddingX(css, '.talk-call-bar');

/**
 * Every flex item on the row, at its intrinsic (unshrunk) width. The caption is
 * absent on purpose: at this width it takes a full-width line of its own
 * (`flex-basis: 100%`) and ellipsizes into it, so it neither competes with the
 * controls nor has an intrinsic width that can overflow.
 */
const items = ((): { name: string; width: number }[] => {
  const monoSize = px(css, '.talk-mono', 'font-size');
  const chip = rule(css, '.talk-budget-chip');
  const chipBorder = Number(/border:\s*([\d.]+)px/.exec(chip)?.[1] ?? 0);
  const control = px(css, '.talk-btn', 'min-width');
  // Every mono label inside the detail button is hidden at this width, so the
  // button is its minimum tap target plus the `···` marker — whichever is wider.
  const detail = Math.max(
    px(css, '.talk-detail-btn', 'min-width'),
    2 * paddingX(narrowCss, '.talk-detail-btn') + monoWidth('···', monoSize),
  );
  return [
    { name: 'indicator', width: px(narrowCss, '.talk-indicator', 'width') },
    {
      name: 'status label',
      width: monoWidth(
        textOf(html, 'talk-status-label'),
        px(css, '.talk-status-label', 'font-size'),
      ),
    },
    {
      name: 'budget chip',
      width:
        monoWidth(textOf(html, 'talk-mono talk-budget-chip'), monoSize) +
        2 * paddingX(css, '.talk-budget-chip') +
        2 * chipBorder,
    },
    {
      name: 'controls',
      width: detail + 2 * control + 2 * columnGap(css, '.talk-call-actions'),
    },
  ];
})();

/** All of the items side by side, gaps included — one unwrapped line. */
const oneLine =
  items.reduce((total, item) => total + item.width, 0) +
  (items.length - 1) * columnGap(css, '.talk-call-row');

describe('CallStrip layout at 375px (DR5)', () => {
  it('cannot fit its widest state on a single line — which is why the row wraps', () => {
    // This is the defect the wrap rule answers, pinned as a number rather than
    // left as a comment. If the strip ever genuinely fits, the guarantee below
    // is what still has to hold and this expectation is the one to revisit.
    expect(
      Math.round(oneLine),
      `widest state is ${Math.round(oneLine)}px in a ${contentBox}px content box`,
    ).toBeGreaterThan(contentBox);
  });

  it('lets the overflow wrap instead of pushing the page sideways', () => {
    expect(rule(css, '.talk-call-row')).toContain('flex-wrap: wrap');
  });

  it('has no single item too wide to be placed on a line of its own', () => {
    // Wrapping moves an item to the next line; it cannot make an item narrower.
    // One item wider than the row is therefore the one case that still
    // overflows, so each has to fit on its own.
    for (const item of items) {
      expect(
        Math.round(item.width),
        `${item.name} is ${Math.round(item.width)}px, wider than the ${contentBox}px row`,
      ).toBeLessThanOrEqual(contentBox);
    }
  });

  it('keeps the caption on screen rather than trading it for the fit', () => {
    // The tempting way to make the arithmetic work is to delete the captions.
    // They are the accessibility story, so the row wraps instead.
    expect(html).toContain('talk-caption');
    const caption = narrowCss.slice(narrowCss.indexOf('.talk-caption'));
    expect(caption.slice(0, caption.indexOf('}'))).not.toContain('display: none');
  });
});
