import { describe, expect, it } from 'vitest';
import { decideFence, declaredSpecVersions, type RendererCapability } from '../activation';
import { FENCE_RENDERER_REGISTRY } from '../registry';

const registry: RendererCapability[] = [{ fenceLang: 'echarts', specVersions: [1] }];
const base = { language: 'echarts', streaming: false, registry };

describe('declaredSpecVersions', () => {
  it('reads well-formed declarations for the requested language only', () => {
    expect(declaredSpecVersions(['echarts@1', 'echarts@2', 'mermaid@1'], 'echarts')).toEqual([
      1, 2,
    ]);
  });

  it('ignores malformed entries', () => {
    expect(
      declaredSpecVersions(['echarts', 'echarts@', 'echarts@1.2', 'ECHARTS@1', ''], 'echarts'),
    ).toEqual([]);
  });
});

describe('decideFence', () => {
  it('renders when the personality declares a spec the registry maps', () => {
    expect(decideFence({ ...base, declarations: ['echarts@1'] })).toEqual({
      kind: 'render',
      fenceLang: 'echarts',
      specVersion: 1,
    });
  });

  it('falls back to code when the personality declares nothing', () => {
    // Loading and errored queries both surface as an empty list — fail-closed.
    expect(decideFence({ ...base, declarations: [] })).toEqual({ kind: 'code' });
  });

  it('falls back to code for an unknown fence language', () => {
    expect(decideFence({ ...base, language: 'mermaid', declarations: ['mermaid@1'] })).toEqual({
      kind: 'code',
    });
  });

  it('falls back to code for an untagged fence', () => {
    expect(decideFence({ ...base, language: '', declarations: ['echarts@1'] })).toEqual({
      kind: 'code',
    });
  });

  it('falls back to code while the message is still streaming', () => {
    expect(decideFence({ ...base, streaming: true, declarations: ['echarts@1'] })).toEqual({
      kind: 'code',
    });
  });

  it('names both sides when the declared spec version is unmapped', () => {
    expect(decideFence({ ...base, declarations: ['echarts@2'] })).toEqual({
      kind: 'version-mismatch',
      fenceLang: 'echarts',
      declared: [2],
      supported: [1],
    });
  });

  it('picks the highest shared spec version during a migration window', () => {
    expect(
      decideFence({
        ...base,
        declarations: ['echarts@1', 'echarts@2'],
        registry: [{ fenceLang: 'echarts', specVersions: [1, 2] }],
      }),
    ).toMatchObject({ kind: 'render', specVersion: 2 });
  });
});

describe('shipped registry', () => {
  it('has exactly one entry — echarts spec 1', () => {
    expect(FENCE_RENDERER_REGISTRY.map((e) => [e.fenceLang, e.specVersions])).toEqual([
      ['echarts', [1]],
    ]);
  });
});
