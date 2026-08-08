import { BarChart, HeatmapChart, LineChart, PieChart, ScatterChart } from 'echarts/charts';
import {
  DatasetComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { memo, useEffect, useRef, useState } from 'react';
import { watchReducedMotion } from '../../lib/reduced-motion';
import { useResolvedTokens } from '../../lib/skin-tokens';
import { buildChartTheme } from './chart-theme';
import type { FenceRendererProps } from './registry';

// The lazy chunk. Nothing outside this module imports echarts, so the library
// lands in its own Vite chunk and is fetched on the first chart render.
//
// Registration is deliberately the spec-1 surface and nothing more: the five
// allowed series types plus the components the allowed top-level keys need.
// That keeps the chunk small and means an option key the spec forbids has no
// implementation to reach even if it somehow got past the filter. It also
// keeps `echarts/lib/coord/geo` — the one module in the package with a
// `new Function` fallback — out of the graph, which matters because the
// desktop shell serves this SPA under `script-src 'self'` with no
// `'unsafe-eval'`.
echarts.use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  HeatmapChart,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  // `heatmap` cannot render without it: HeatmapView throws
  // "Heatmap must use with visualMap" in dev and paints monochrome in prod.
  VisualMapComponent,
  CanvasRenderer,
]);

const THEME_NAME = 'ethos';
const CHART_HEIGHT_PX = 320;

function EChartsBlock({ option }: FenceRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tokens = useResolvedTokens();
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => watchReducedMotion(setReduceMotion), []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Theme is baked in at `init`, so a skin or reduced-motion change tears
    // the instance down and rebuilds it — that is what re-themes an
    // already-rendered chart.
    echarts.registerTheme(THEME_NAME, buildChartTheme(tokens, reduceMotion));
    const chart = echarts.init(el, THEME_NAME, { renderer: 'canvas' });
    try {
      chart.setOption(option);
    } catch (err) {
      // A throw here escapes to the error boundary *before* the cleanup below
      // is registered, so the instance would leak its zrender handle and
      // resize listener. Dispose first, then let the boundary take over.
      chart.dispose();
      throw err;
    }
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(el);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [option, tokens, reduceMotion]);

  return (
    <div className="chart-block">
      <div ref={containerRef} className="chart-block-canvas" style={{ height: CHART_HEIGHT_PX }} />
    </div>
  );
}

/**
 * The fence source is the identity. The markdown subtree re-renders on every
 * streamed token of the *next* message; without this the chart would
 * re-`setOption` (and replay its animation) each time even though the spec
 * never changed.
 */
export default memo(EChartsBlock, (prev, next) => prev.source === next.source);
