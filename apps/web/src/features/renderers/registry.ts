import { type ComponentType, type LazyExoticComponent, lazy } from 'react';
import type { RendererCapability } from './activation';
import { parseChartFence } from './echarts-spec';

// The surface's half of the two-level versioning contract. Skills declare a
// *spec* version (`echarts@1`); this file pins the *library* version and owns
// the spec→renderer map, so an echarts major bump is a diff here and nothing
// else. Skills cannot register renderers — extending this list is a reviewed
// PR to this repo, which is what keeps third-party skills safe to install.

export interface FenceRendererProps {
  /** Raw fence body — also the React.memo identity for the rendered block. */
  source: string;
  /** Spec-filtered option, produced by the entry's own `prepare`. */
  option: Record<string, unknown>;
}

export interface FenceRendererEntry extends RendererCapability {
  /**
   * Fence body → renderable payload, or `null` when the body is not a valid
   * spec. Runs on the activation path, so it must not import the renderer
   * library — otherwise the lazy chunk stops being lazy.
   */
  prepare: (source: string) => Record<string, unknown> | null;
  load: () => Promise<{ default: ComponentType<FenceRendererProps> }>;
}

export const FENCE_RENDERER_REGISTRY: readonly FenceRendererEntry[] = [
  {
    fenceLang: 'echarts',
    specVersions: [1],
    prepare: parseChartFence,
    load: () => import('./echarts-block'),
  },
];

// `lazy()` is called once, here. Calling it inside a component would mint a
// fresh element type on every render, remounting the chart (and re-running
// Suspense) on every streamed token.
export const LAZY_FENCE_RENDERERS: ReadonlyMap<
  string,
  LazyExoticComponent<ComponentType<FenceRendererProps>>
> = new Map(FENCE_RENDERER_REGISTRY.map((entry) => [entry.fenceLang, lazy(entry.load)]));
