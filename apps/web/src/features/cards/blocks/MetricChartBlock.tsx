import { lazy, Suspense, useMemo } from 'react';
import { buildMetricChartOption } from '../metric-chart-option';
import type { CardBlockProps } from '../registry';
import { UnknownCardBlock } from './UnknownCardBlock';

// The chart itself is the module the fence renderers already lazy-load —
// same import specifier, so Vite gives both paths one chunk, one `echarts.use`
// registration and one copy of the theme. This card contributes the payload →
// option mapping and nothing else; it registers no series types of its own
// (see the note in `echarts-block.tsx` about keeping `coord/geo` out of the
// graph under the desktop shell's `script-src 'self'`).
//
// `lazy()` at module scope, once — inside the component it would mint a fresh
// element type per render and remount the chart on every streamed token.
const LazyEChartsBlock = lazy(() => import('../../renderers/echarts-block'));

export function MetricChartBlock({ card }: CardBlockProps) {
  const payload = card.kind === 'metric_chart' ? card.payload : null;
  // `source` is the memo identity `EChartsBlock` compares on, so it has to be
  // a stable string for an unchanged payload — not the option object. Both are
  // derived in one pass so they can never disagree about which payload they
  // describe.
  const { source, option } = useMemo(
    () =>
      payload
        ? { source: JSON.stringify(payload), option: buildMetricChartOption(payload) }
        : { source: '', option: {} },
    [payload],
  );

  if (!payload) return <UnknownCardBlock card={card} />;
  return (
    <div className="card-block card-metric-chart">
      {payload.title ? <div className="card-title">{payload.title}</div> : null}
      <Suspense fallback={<div className="card-chart-loading">Loading chart…</div>}>
        <LazyEChartsBlock source={source} option={option} />
      </Suspense>
    </div>
  );
}
