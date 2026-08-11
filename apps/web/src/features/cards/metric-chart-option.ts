import type { MetricChartCardPayload } from '@ethosagent/web-contracts';

// Payload → echarts option. Pure, so the mapping is testable without mounting
// a chart (same split as `chart-theme.ts`).
//
// `suggestedViz` is advisory: the model says what it thinks the data looks
// like, the client decides. We honour it when it is expressible with the
// series types `features/renderers/echarts-block.tsx` already registers —
// line / bar / scatter, plus area as a line with a fill — and fall back to a
// shape chosen from the data otherwise. Nothing here may need a series type
// outside that set; adding one would pull new modules into the echarts chunk.

type SeriesType = 'line' | 'bar' | 'scatter';

/** Points 1-12 wide on a categorical axis read better as bars than as a line. */
const CATEGORY_BAR_LIMIT = 12;

function isCategorical(payload: MetricChartCardPayload): boolean {
  return payload.series.every((s) => s.points.every((p) => typeof p.x === 'string'));
}

function chooseSeriesType(payload: MetricChartCardPayload): { type: SeriesType; area: boolean } {
  switch (payload.suggestedViz) {
    case 'bar':
      return { type: 'bar', area: false };
    case 'scatter':
      return { type: 'scatter', area: false };
    case 'area':
      return { type: 'line', area: true };
    case 'line':
      return { type: 'line', area: false };
    default: {
      const longest = Math.max(...payload.series.map((s) => s.points.length));
      const bars = isCategorical(payload) && longest <= CATEGORY_BAR_LIMIT;
      return { type: bars ? 'bar' : 'line', area: false };
    }
  }
}

export function buildMetricChartOption(payload: MetricChartCardPayload): Record<string, unknown> {
  const { type, area } = chooseSeriesType(payload);
  const categorical = isCategorical(payload);
  // Category axes need one shared, de-duplicated label list; the series then
  // ship bare y values positionally.
  const categories = categorical
    ? [...new Set(payload.series.flatMap((s) => s.points.map((p) => String(p.x))))]
    : [];

  return {
    grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
    tooltip: { trigger: type === 'scatter' ? 'item' : 'axis' },
    ...(payload.series.length > 1 ? { legend: { top: 0 } } : {}),
    xAxis: categorical
      ? { type: 'category', data: categories, name: payload.xLabel }
      : { type: 'value', name: payload.xLabel },
    yAxis: { type: 'value', name: payload.yLabel },
    series: payload.series.map((s) => ({
      name: s.name,
      type,
      ...(area ? { areaStyle: {} } : {}),
      ...(type === 'line' ? { showSymbol: s.points.length <= 60, smooth: false } : {}),
      data: categorical
        ? categories.map((c) => s.points.find((p) => String(p.x) === c)?.y ?? null)
        : s.points.map((p) => [p.x, p.y]),
    })),
  };
}
