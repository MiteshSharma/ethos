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
    // The red AudioBars meter animates via a transition, not a keyframe.
    expect(rule).toContain('.composer-voice-bar');
  });

  it('at 375px the mark, state and controls persist; the mono detail collapses', () => {
    const start = css.indexOf('@media (max-width: 420px)');
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(start, css.indexOf('/* Every pulse stops', start));
    // Collapsed behind the toggle's tap target.
    expect(rule).toContain('.talk-detail-btn .talk-mono:not(.talk-latency)');
    expect(rule).toContain('display: none');
    // The indicator narrows but stays; nothing hides the controls.
    expect(rule).toContain('.talk-indicator');
    expect(rule).not.toContain('.talk-call-actions');
    expect(rule).not.toContain('.talk-status-label');
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
