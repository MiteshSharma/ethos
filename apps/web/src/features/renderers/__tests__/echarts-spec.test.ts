import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseChartFence, sanitizeChartOption } from '../echarts-spec';

const SKILL_PATH = join(import.meta.dirname, '../../../../../../skills/document/charts/SKILL.md');

/** Every ```echarts fence in the skill body, in document order. */
function skillEchartsFences(): string[] {
  const body = readFileSync(SKILL_PATH, 'utf8');
  const fences: string[] = [];
  const re = /^```echarts\n([\s\S]*?)^```$/gm;
  for (;;) {
    const match = re.exec(body);
    if (!match?.[1]) break;
    fences.push(match[1]);
  }
  return fences;
}

describe('spec-1 conformance with skills/document/charts/SKILL.md', () => {
  // The skill teaches the grammar and the filter enforces it. Reading the real
  // file (rather than a copy) is what keeps the two from drifting: a spec-1
  // example the filter would mangle fails here.
  const fences = skillEchartsFences();

  it('extracts the documented examples from the real skill file', () => {
    expect(fences.length).toBeGreaterThanOrEqual(3);
  });

  it('exercises heatmap, the one series type with a required companion key', () => {
    // A series type documented but never exercised is how `heatmap` shipped
    // against a top-level allowlist that omitted the `visualMap` it requires.
    const charted = new Set(
      fences.flatMap((source) => {
        const option = JSON.parse(source) as { series?: { type?: string }[] };
        return (option.series ?? []).map((s) => s.type);
      }),
    );
    expect(charted.has('heatmap')).toBe(true);
  });

  it.each(fences.map((source, i) => [i, source]))(
    'example %i survives the allowlist filter unchanged',
    (_i, source) => {
      const parsed: unknown = JSON.parse(source);
      expect(sanitizeChartOption(parsed)).toEqual(parsed);
    },
  );
});

describe('sanitizeChartOption', () => {
  const minimal = {
    title: { text: 'x' },
    xAxis: { type: 'category', data: ['a'] },
    yAxis: { type: 'value' },
    series: [{ type: 'line', data: [1] }],
  };

  it('rejects a non-object root', () => {
    expect(sanitizeChartOption([1, 2, 3])).toBeNull();
    expect(sanitizeChartOption('bar')).toBeNull();
    expect(sanitizeChartOption(null)).toBeNull();
    expect(sanitizeChartOption(42)).toBeNull();
  });

  it('rejects an option with no series', () => {
    expect(sanitizeChartOption({ title: { text: 'x' } })).toBeNull();
  });

  it('drops series of a type outside spec 1 and falls back when none survive', () => {
    expect(
      sanitizeChartOption({ ...minimal, series: [{ type: 'graph' }, { type: 'bar', data: [1] }] }),
    ).toMatchObject({ series: [{ type: 'bar', data: [1] }] });
    expect(sanitizeChartOption({ ...minimal, series: [{ type: 'sankey' }] })).toBeNull();
  });

  it('drops top-level keys outside spec 1', () => {
    const result = sanitizeChartOption({ ...minimal, toolbox: {}, dataZoom: {}, width: 800 });
    expect(result).not.toBeNull();
    expect(Object.keys(result ?? {}).sort()).toEqual(['series', 'title', 'xAxis', 'yAxis']);
  });

  it('keeps visualMap — heatmap cannot render without it', () => {
    const result = sanitizeChartOption({
      ...minimal,
      series: [{ type: 'heatmap', data: [[0, 0, 4]] }],
      visualMap: { min: 0, max: 12, calculable: true, inRange: { color: ['#eef', '#4A9EFF'] } },
    });
    expect(result?.visualMap).toEqual({
      min: 0,
      max: 12,
      calculable: true,
      inRange: { color: ['#eef', '#4A9EFF'] },
    });
  });

  it('still filters sinks inside visualMap', () => {
    const result = sanitizeChartOption({
      ...minimal,
      visualMap: {
        min: 0,
        formatter: '<img src=x onerror="alert(1)">',
        textStyle: { color: 'red;position:fixed' },
        handleIcon: 'image://https://tracker.example/pixel.png',
      },
    });
    expect(result?.visualMap).toEqual({ min: 0, textStyle: {} });
  });

  it('drops image:// strings anywhere — spec 1 has no remote references', () => {
    const result = sanitizeChartOption({
      ...minimal,
      legend: { icon: 'image://https://tracker.example/pixel.png' },
      series: [{ type: 'scatter', symbol: 'image://https://tracker.example/p.png', data: [1] }],
    });
    expect(result?.legend).toEqual({});
    expect(result?.series).toEqual([{ type: 'scatter', data: [1] }]);
  });

  it('strips function-shaped strings wherever they appear', () => {
    const result = sanitizeChartOption({
      ...minimal,
      tooltip: {
        trigger: 'axis',
        formatter: 'function (p) { return p.value; }',
        valueFormatter: '(v) => v + "%"',
        axisPointer: { label: { formatter: 'p => p.value' } },
      },
    });
    expect(result?.tooltip).toEqual({ trigger: 'axis', axisPointer: { label: {} } });
  });

  it('keeps the plain-string template form the skill recommends', () => {
    const result = sanitizeChartOption({
      ...minimal,
      tooltip: { formatter: '{b}: {c}' },
    });
    expect(result?.tooltip).toEqual({ formatter: '{b}: {c}' });
  });

  it('refuses a tooltip formatter carrying markup', () => {
    // A string `tooltip.formatter` becomes the tooltip's innerHTML verbatim —
    // echarts escapes the substituted {b}/{c} values, never the template.
    const result = sanitizeChartOption({
      ...minimal,
      tooltip: { trigger: 'axis', formatter: '<img src=x onerror="alert(1)">' },
      series: [{ type: 'bar', data: [1], tooltip: { formatter: '<script>alert(2)</script>' } }],
    });
    expect(result?.tooltip).toEqual({ trigger: 'axis' });
    expect(JSON.stringify(result)).not.toContain('<');
  });

  it('drops navigation and raw-CSS sinks at any depth', () => {
    const result = sanitizeChartOption({
      ...minimal,
      title: { text: 't', link: 'javascript:alert(3)', target: 'self' },
      tooltip: { extraCssText: 'position:fixed;inset:0' },
    });
    expect(result?.title).toEqual({ text: 't' });
    expect(result?.tooltip).toEqual({});
  });

  it('drops colour strings carrying extra CSS declarations', () => {
    const result = sanitizeChartOption({
      ...minimal,
      color: ['#4A9EFF', 'red;position:fixed;inset:0'],
      tooltip: { borderColor: 'red;width:100vw' },
    });
    expect(result?.color).toEqual(['#4A9EFF', null]);
    expect(result?.tooltip).toEqual({});
  });

  it('keeps array positions when an element is dropped', () => {
    // xAxis.data[i] pairs with series.data[i]; compacting would silently
    // rebind every later value to the wrong category.
    const result = sanitizeChartOption({
      ...minimal,
      xAxis: { type: 'category', data: ['auth', 'api => db', 'cache'] },
      series: [{ type: 'bar', data: [1, 2, 3] }],
    });
    expect(result?.xAxis).toEqual({ type: 'category', data: ['auth', null, 'cache'] });
  });

  it('refuses prototype-polluting keys', () => {
    const raw = JSON.parse('{"series":[{"type":"bar","__proto__":{"polluted":true}}]}');
    const result = sanitizeChartOption(raw);
    expect(JSON.stringify(result)).not.toContain('polluted');
  });

  it('drops non-finite numbers', () => {
    const result = sanitizeChartOption({ ...minimal, grid: { top: Number.NaN, left: 8 } });
    expect(result?.grid).toEqual({ left: 8 });
  });
});

describe('parseChartFence', () => {
  it('returns null for invalid JSON', () => {
    expect(parseChartFence('{ "series": [')).toBeNull();
    expect(parseChartFence('not json at all')).toBeNull();
  });

  it('returns null for a valid-JSON non-object root', () => {
    expect(parseChartFence('[1,2,3]')).toBeNull();
  });

  it('parses a well-formed spec', () => {
    expect(parseChartFence('{"series":[{"type":"pie","data":[1,2]}]}')).toEqual({
      series: [{ type: 'pie', data: [1, 2] }],
    });
  });
});
