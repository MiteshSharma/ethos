import { teamRingArcs } from '@ethosagent/web-contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TeamRing } from '../TeamRing';

// TeamRing is hook-free, so it renders with `renderToStaticMarkup` — the
// no-DOM pattern the app's component tests use. The geometry itself is
// locked in `packages/web-contracts/src/__tests__/marks.test.ts`; this
// checks the component draws exactly what `teamRingArcs` says, the way the
// prototype's `ring()` does.

const ACCENTS = ['#4A9EFF', '#4ADE80', '#F59E0B'];

function render(props: Parameters<typeof TeamRing>[0]): string {
  return renderToStaticMarkup(createElement(TeamRing, props));
}

describe('TeamRing', () => {
  it('draws one arc per accent over the faint neutral fill, rotated so arcs start at 12 o’clock', () => {
    const html = render({ accents: ACCENTS, size: 22 });
    const circles = html.match(/<circle/g) ?? [];
    expect(circles).toHaveLength(ACCENTS.length + 1);
    expect(html).toContain('fill="#E8E8E6"');
    expect(html).toContain('fill-opacity="0.06"');
    for (const accent of ACCENTS) expect(html).toContain(`stroke="${accent}"`);
    expect(html).toContain('transform="rotate(-90 11 11)"');
  });

  it('uses the geometry twin verbatim (dasharray, offset, radius, stroke width)', () => {
    const html = render({ accents: ACCENTS, size: 36 });
    for (const arc of teamRingArcs(ACCENTS, 36)) {
      expect(html).toContain(`stroke-dasharray="${arc.dashArray}"`);
      expect(html).toContain(`stroke-dashoffset="${arc.dashOffset}"`);
      expect(html).toContain(`r="${arc.r}"`);
      expect(html).toContain(`stroke-width="${arc.strokeWidth}"`);
    }
  });

  it('sizes the svg and viewBox to `size`, block-level and non-flexing', () => {
    const html = render({ accents: ACCENTS, size: 14 });
    expect(html).toContain('width="14"');
    expect(html).toContain('height="14"');
    expect(html).toContain('viewBox="0 0 14 14"');
    expect(html).toContain('display:block');
    expect(html).toContain('flex:none');
  });

  it('is an image labelled by the team name, defaulting to "Team"', () => {
    expect(render({ accents: ACCENTS, size: 22 })).toContain('aria-label="Team"');
    const titled = render({ accents: ACCENTS, size: 22, title: 'marketing' });
    expect(titled).toContain('role="img"');
    expect(titled).toContain('aria-label="marketing"');
  });

  it('passes className through', () => {
    expect(render({ accents: ACCENTS, size: 22, className: 'rail-ring' })).toContain(
      'class="rail-ring"',
    );
  });

  it('an empty roster still has the inner fill footprint and no arcs', () => {
    const html = render({ accents: [], size: 22 });
    expect(html.match(/<circle/g) ?? []).toHaveLength(1);
    expect(html).toContain('fill="#E8E8E6"');
  });
});
