// P2-counters — OpenMetrics text rendering (D14) and the 5s TTL response
// cache (decision 6 / D2).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetricCounterRow } from '../metric-counters';
import { createMetricsTextProvider, renderMetricsText } from '../metrics-text';

describe('renderMetricsText', () => {
  it('renders TYPE headers and lines for counters, histograms, and the gauge', () => {
    const rows: MetricCounterRow[] = [
      {
        metric: 'ethos_llm_cost_usd_total',
        labels: { personality: 'engineer', provider: 'anthropic', model: 'claude-sonnet-5' },
        value: 0.42,
      },
      {
        metric: 'ethos_llm_request_duration_seconds_bucket',
        labels: { provider: 'anthropic', model: 'claude-sonnet-5', le: '1' },
        value: 3,
      },
      {
        metric: 'ethos_llm_request_duration_seconds_sum',
        labels: { provider: 'anthropic', model: 'claude-sonnet-5' },
        value: 1.5,
      },
      {
        metric: 'ethos_llm_request_duration_seconds_count',
        labels: { provider: 'anthropic', model: 'claude-sonnet-5' },
        value: 3,
      },
    ];

    const text = renderMetricsText(rows, [{ adapter: 'telegram', up: 1 }]);

    expect(text).toContain('# TYPE ethos_llm_cost_usd_total counter');
    expect(text).toContain(
      'ethos_llm_cost_usd_total{model="claude-sonnet-5",personality="engineer",provider="anthropic"} 0.42',
    );
    expect(text).toContain('# TYPE ethos_llm_request_duration_seconds histogram');
    expect(text).toContain(
      'ethos_llm_request_duration_seconds_bucket{le="1",model="claude-sonnet-5",provider="anthropic"} 3',
    );
    expect(text).toContain('# TYPE ethos_gateway_adapter_up gauge');
    expect(text).toContain('ethos_gateway_adapter_up{adapter="telegram"} 1');
  });

  it('renders ethos_memory_writes_total and ethos_http_requests_total', () => {
    const rows: MetricCounterRow[] = [
      {
        metric: 'ethos_memory_writes_total',
        labels: { store: 'memory', action: 'add' },
        value: 3,
      },
      {
        metric: 'ethos_http_requests_total',
        labels: { method: 'GET', status: '200' },
        value: 7,
      },
    ];

    const text = renderMetricsText(rows, []);

    expect(text).toContain('# TYPE ethos_memory_writes_total counter');
    expect(text).toContain('ethos_memory_writes_total{action="add",store="memory"} 3');
    expect(text).toContain('# TYPE ethos_http_requests_total counter');
    expect(text).toContain('ethos_http_requests_total{method="GET",status="200"} 7');
  });

  it('drops a row for a metric name outside the fixed family list (D18)', () => {
    const rows: MetricCounterRow[] = [{ metric: 'not_a_real_metric', labels: {}, value: 1 }];
    expect(renderMetricsText(rows, [])).toBe('');
  });

  it('renders an empty-DB scrape cleanly', () => {
    expect(renderMetricsText([], [])).toBe('');
  });

  it('stale heartbeat reports adapter_up 0', () => {
    const text = renderMetricsText([], [{ adapter: 'discord', up: 0 }]);
    expect(text).toContain('ethos_gateway_adapter_up{adapter="discord"} 0');
  });

  it('escapes backslash, quote, and newline in label values (D19)', () => {
    const rows: MetricCounterRow[] = [
      {
        metric: 'ethos_turn_outcomes_total',
        // A personality display name is user-controlled UTF-8 and may embed
        // characters that would otherwise break the exposition format.
        labels: { personality: 'quo"te\\back\nline', platform: 'cli', status: 'ok' },
        value: 1,
      },
    ];
    const text = renderMetricsText(rows, []);
    expect(text).toContain('personality="quo\\"te\\\\back\\nline"');
  });

  it('round-trips a non-ASCII personality name unescaped', () => {
    const rows: MetricCounterRow[] = [
      {
        metric: 'ethos_turn_outcomes_total',
        labels: { personality: '万事屋 🎉', platform: 'cli', status: 'ok' },
        value: 1,
      },
    ];
    const text = renderMetricsText(rows, []);
    expect(text).toContain('personality="万事屋 🎉"');
  });
});

describe('createMetricsTextProvider — 5s TTL cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hits the store once for two scrapes inside the TTL window', async () => {
    const getMetricCounters = vi.fn(() => [] as MetricCounterRow[]);
    const getMetrics = createMetricsTextProvider({
      store: { getMetricCounters },
      getGatewayAdapters: () => [],
    });

    await getMetrics();
    vi.advanceTimersByTime(1000);
    await getMetrics();

    expect(getMetricCounters).toHaveBeenCalledTimes(1);
  });

  it('re-reads the store once the TTL has elapsed', async () => {
    const getMetricCounters = vi.fn(() => [] as MetricCounterRow[]);
    const getMetrics = createMetricsTextProvider({
      store: { getMetricCounters },
      getGatewayAdapters: () => [],
    });

    await getMetrics();
    vi.advanceTimersByTime(5001);
    await getMetrics();

    expect(getMetricCounters).toHaveBeenCalledTimes(2);
  });
});
