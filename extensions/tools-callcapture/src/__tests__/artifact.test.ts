import { describe, expect, it } from 'vitest';
import { buildDigestLine } from '../artifact';

const STARTED_AT = new Date('2026-08-16T14:30:22.123Z').getTime();

describe('buildDigestLine', () => {
  it('wraps the short summary in <untrusted> when hasEntries is true, and stays one physical line', () => {
    const line = buildDigestLine({
      startedAt: STARTED_AT,
      source: 'zoom',
      summary: 'Discussed the roadmap. Agreed to ship Friday.',
      key: 'zoom-2026-08-16-143022.md',
      hasEntries: true,
    });

    expect(line).toContain('<untrusted source="zoom" tool="call-capture">');
    expect(line).toContain('</untrusted>');
    expect(line).not.toContain('\n');
  });

  it('does not wrap the summary when hasEntries is false, and still stays one physical line', () => {
    const line = buildDigestLine({
      startedAt: STARTED_AT,
      source: 'call',
      summary: 'No speech was captured.',
      key: 'call-2026-08-16-143022.md',
      hasEntries: false,
    });

    expect(line).not.toContain('<untrusted');
    expect(line).not.toContain('\n');
    expect(line).toMatch(
      /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} — call — No speech was captured\. \(see call-2026-08-16-143022\.md\)$/,
    );
  });

  it('preserves the summary text content and the trailing "(see <key>)" pointer when wrapped', () => {
    const line = buildDigestLine({
      startedAt: STARTED_AT,
      source: 'meet',
      summary: 'Reviewed Q3 budget numbers.',
      key: 'meet-2026-08-16-143022.md',
      hasEntries: true,
    });

    expect(line).toContain('Reviewed Q3 budget numbers.');
    expect(line.endsWith('(see meet-2026-08-16-143022.md)')).toBe(true);
  });
});
