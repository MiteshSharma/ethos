import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import { RenderedFence, SpecVersionNotice } from '../FenceBlock';
import { makeFenceResolver } from '../resolver';

// One fixture, decided against the real shipped registry. The only thing that
// changes between the two headline cases is what the personality's skill set
// declares.
const FIXTURE = JSON.stringify({
  title: { text: 'Errors by service' },
  xAxis: { type: 'category', data: ['auth', 'api'] },
  yAxis: { type: 'value' },
  series: [{ type: 'bar', data: [12, 31] }],
});

const fence = (code = FIXTURE, streaming = false) => ({ language: 'echarts', code, streaming });

describe('makeFenceResolver', () => {
  it('renders a chart when the personality declares echarts@1', () => {
    const result = makeFenceResolver(['echarts@1'])(fence());
    expect(result?.kind).toBe('replace');
    const node = result?.kind === 'replace' ? result.node : null;
    expect(isValidElement(node)).toBe(true);
    expect(isValidElement(node) && node.type).toBe(RenderedFence);
    expect(isValidElement(node) && (node.props as { option: unknown }).option).toEqual(
      JSON.parse(FIXTURE),
    );
  });

  it('renders the identical fence as a code block without the charts skill', () => {
    expect(makeFenceResolver([])(fence())).toBeNull();
    expect(makeFenceResolver(['make-chart@1'])(fence())).toBeNull();
  });

  it('names both versions when the declared spec is unmapped', () => {
    const result = makeFenceResolver(['echarts@2'])(fence());
    expect(result?.kind).toBe('annotate');
    const notice = result?.kind === 'annotate' ? result.notice : null;
    expect(isValidElement(notice) && notice.type).toBe(SpecVersionNotice);
    expect(isValidElement(notice) && notice.props).toMatchObject({
      fenceLang: 'echarts',
      declared: [2],
      supported: [1],
    });
  });

  it('falls back for invalid JSON even with the skill declared', () => {
    expect(makeFenceResolver(['echarts@1'])(fence('{ "series": ['))).toBeNull();
  });

  it('falls back for a non-object root', () => {
    expect(makeFenceResolver(['echarts@1'])(fence('[1,2,3]'))).toBeNull();
  });

  it('falls back when nothing survives the allowlist filter', () => {
    expect(
      makeFenceResolver(['echarts@1'])(fence('{"series":[{"type":"sunburst","data":[1]}]}')),
    ).toBeNull();
  });

  it('falls back for an unknown fence language', () => {
    expect(
      makeFenceResolver(['mermaid@1'])({
        language: 'mermaid',
        code: 'graph TD;',
        streaming: false,
      }),
    ).toBeNull();
  });

  it('falls back while the fence is still streaming', () => {
    expect(makeFenceResolver(['echarts@1'])(fence(FIXTURE, true))).toBeNull();
  });
});
