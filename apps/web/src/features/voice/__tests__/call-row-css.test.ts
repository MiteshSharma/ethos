import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The promises CallRow keeps in CSS rather than in markup. Asserted against the
// stylesheet itself, which is the artifact that actually ships and the thing a
// careless refactor silently drops. Same technique as `call-strip-css.test.ts`.

const css = readFileSync(join(import.meta.dirname, '..', '..', '..', 'styles.css'), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing rule: ${selector}`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
}

describe('CallRow stylesheet', () => {
  it('the live-call state EXTENDS the connection dot instead of drawing a new one', () => {
    // The modifier only means anything if `.sb-dot` still supplies the shape.
    expect(block('.sb-dot')).toContain('border-radius: 50%');
    const live = block('.sb-dot--call-live');
    expect(live).toContain('var(--accent');
    expect(live).toContain('animation: status-dot-pulse');
    // Reuses the existing keyframe — no second motion primitive for a dot.
    expect(css).toContain('@keyframes status-dot-pulse');
  });

  it('the live dot is distinguishable from the satellite speaking dot without motion', () => {
    // Both are accent fills. A list can show a live call and a speaking
    // satellite at once, so the ring is what separates them — and it is the
    // half that survives `prefers-reduced-motion`.
    expect(block('.sb-dot--call-live')).toContain('outline:');
    expect(block('.sb-dot--speaking')).not.toContain('outline:');
  });

  it('prefers-reduced-motion stops the live pulse and keeps the ring', () => {
    const start = css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('.call-row'));
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(start, css.indexOf('}\n}', start));
    expect(rule).toContain('.sb-dot--call-live');
    expect(rule).toContain('animation: none');
    // The ring is a static declaration on the modifier, so nothing here has to
    // restore it — and nothing here may remove it.
    expect(rule).not.toContain('outline: none');
  });

  it('numbers, durations and ids are Geist Mono with tabular figures', () => {
    const mono = block('.call-mono');
    expect(mono).toContain('"Geist Mono"');
    expect(mono).toContain('font-variant-numeric: tabular-nums');
  });

  it('a call row is a bordered LIST row, not a boxed card', () => {
    const row = block('.call-row');
    // A single rule between rows; no border box, no radius, no shadow.
    expect(row).toContain('border-bottom: 1px solid var(--ethos-border)');
    expect(row).not.toContain('border-radius');
    expect(row).not.toContain('box-shadow');
    expect(block('.call-row:last-child')).toContain('border-bottom: none');
  });

  it('the tier chip uses the sm (4px) chip radius, not the md card radius', () => {
    expect(block('.call-tier')).toContain('border-radius: 4px');
  });

  it('the filter chip matches the shape Activity already established', () => {
    const chip = block('.call-filter-chip');
    const activity = block('.activity-filter-chip');
    for (const declaration of ['font-size: 12px', 'padding: 4px 12px', 'border-radius: 4px']) {
      expect(chip).toContain(declaration);
      expect(activity).toContain(declaration);
    }
    expect(block('.call-filter-chip.active')).toContain('var(--ethos-info)');
  });
});
