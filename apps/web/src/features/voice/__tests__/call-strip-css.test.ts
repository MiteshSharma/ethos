import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The three DR5 promises that live in CSS rather than in markup: ≥44px touch
// targets, `prefers-reduced-motion` stopping EVERY pulse, and a defined 375px
// layout. There is no DOM in this suite, so they are asserted against the
// stylesheet itself — which is the artifact that actually ships, and the thing
// a careless refactor silently drops.

const css = readFileSync(join(import.meta.dirname, '..', '..', '..', 'styles.css'), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing rule: ${selector}`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
}

describe('CallStrip stylesheet — accessibility & responsive (DR5)', () => {
  it('every strip control is a ≥44px touch target', () => {
    const btn = block('.talk-btn');
    expect(btn).toContain('min-width: 44px');
    expect(btn).toContain('min-height: 44px');
    // The expandable per-turn detail is a control too.
    expect(block('.talk-detail-btn')).toContain('min-width: 44px');
  });

  it('prefers-reduced-motion stops all of the pulses, not just the accent dot', () => {
    const start = css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('.talk-btn'));
    const rule = css.slice(start, start + 400);
    expect(rule).toContain('.talk-agent-pulse');
    expect(rule).toContain('.talk-link-pulse');
    expect(rule).toContain('.talk-indicator-flash');
    expect(rule).toContain('animation: none');
    // The red AudioBars meter's SMOOTHING is a transition, not a keyframe.
    expect(rule).toContain('.composer-voice-bar');
    // Its MOTION is neither: the bar heights are rewritten from JS on every
    // animation frame, so nothing in this file can stop them and no assertion
    // here can prove they stopped. That belongs to `mic-meter.test.ts`.
  });

  it('at 375px the mark, state, caption and controls persist; the mono detail collapses', () => {
    const start = css.indexOf('@media (max-width: 420px)');
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(start, css.indexOf('/* Every pulse stops', start));
    // ALL of the mono detail collapses behind the toggle's tap target — the
    // latency reading included. The plan says "mono latency/tier detail
    // collapses behind a tap"; the old `:not(.talk-latency)` exemption pinned
    // the opposite, and put the widest text back on the narrowest row.
    expect(rule).toContain('.talk-detail-btn .talk-mono');
    expect(rule).not.toContain(':not(.talk-latency)');
    expect(rule).toContain('display: none');
    // The indicator narrows but stays; nothing hides the controls.
    expect(rule).toContain('.talk-indicator');
    expect(rule).not.toContain('.talk-call-actions');
    expect(rule).not.toContain('.talk-status-label');
    // Captions are the a11y story, so the phone keeps them — on their own
    // full-width line rather than not at all.
    const caption = rule.slice(rule.indexOf('.talk-caption'));
    expect(caption.slice(0, caption.indexOf('}'))).not.toContain('display: none');
    expect(rule).toContain('flex-basis: 100%');
  });

  it('the strip row cannot push its widest state past the viewport', () => {
    // The structural half of the 375px contract; `call-strip-layout.test.ts`
    // does the arithmetic that says why this rule has to be here.
    expect(block('.talk-call-row')).toContain('flex-wrap: wrap');
    // The one item wrapping cannot rescue is an item wider than the row, and
    // the state word doubles as the recoverable-error slot.
    expect(block('.talk-status-label')).not.toContain('flex-shrink: 0');
    expect(block('.talk-status-label')).toContain('min-width: 0');
  });

  it('the agent dot is 10px accent and the link dot is the amber warning token', () => {
    expect(block('.talk-agent-dot')).toContain('background: var(--accent, var(--ethos-info))');
    expect(block('.talk-agent-dot')).toContain('width: 10px');
    expect(block('.talk-link-pulse')).toContain('background: var(--ethos-warning)');
    // Reuses the existing keyframe — no new motion primitive.
    expect(block('.talk-link-pulse')).toContain('status-dot-pulse');
  });

  it('the mono labels use Geist Mono, matching the {provider} · {model} vocabulary', () => {
    expect(block('.talk-mono')).toContain('"Geist Mono"');
    expect(block('.talk-status-label')).toContain('"Geist Mono"');
  });
});
