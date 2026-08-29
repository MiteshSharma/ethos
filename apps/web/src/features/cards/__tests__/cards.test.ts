import { DEFAULT_TOKENS } from '@ethosagent/design-tokens';
import type { CardEnvelope } from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CanvasBlock } from '../blocks/CanvasBlock';
import { ActionPills } from '../blocks/RecommendActionsBlock';
import { UnknownCardBlock } from '../blocks/UnknownCardBlock';
import { CardView } from '../CardView';
import { buildCanvasSrcDoc, CANVAS_CSP, CANVAS_DATA_GLOBAL } from '../canvas-srcdoc';
import { buildMetricChartOption } from '../metric-chart-option';
import { resolveCardRenderer } from '../registry';

// The apps/web suite renders to static markup — no jsdom, no testing-library
// (same constraint `markdown-fence-seam.test.ts` works under). Components are
// asserted through their emitted HTML; the one interaction here (a pill click)
// is exercised by calling the hook-free `ActionPills` and invoking the element
// handler directly.

function render(card: CardEnvelope): string {
  return renderToStaticMarkup(createElement(CardView, { card }));
}

/** `card`s are built as literals so the discriminated union stays checked. */
const CARDS = {
  text: {
    kind: 'text',
    specVersion: 1,
    payload: { title: 'Summary', text: 'The **breadth** reading improved.' },
  },
  code: {
    kind: 'code',
    specVersion: 1,
    payload: { title: 'query.sql', language: 'sql', code: 'select 1 from dual' },
  },
  alert: {
    kind: 'alert',
    specVersion: 1,
    payload: { severity: 'warning', title: 'Stale data', message: 'Prices are 40 minutes old.' },
  },
  detail: {
    kind: 'detail',
    specVersion: 1,
    payload: {
      title: 'Order 4471',
      status: 'settled',
      fields: [{ label: 'Notional', value: '₹1,20,000' }],
    },
  },
  item_list: {
    kind: 'item_list',
    specVersion: 1,
    payload: {
      title: 'Watchlist',
      items: [{ id: 'NSE:INFY', name: 'Infosys', status: 'warn', meta: '-2.1% today' }],
    },
  },
  data_table: {
    kind: 'data_table',
    specVersion: 1,
    payload: {
      title: 'Sector flow',
      caption: 'Source: NSE bhavcopy',
      columns: [
        { key: 'sector', label: 'Sector' },
        { key: 'flow', label: 'Flow', numeric: true },
      ],
      rows: [{ sector: 'Banks', flow: 1240 }],
      totals: { sector: 'All', flow: 3100 },
    },
  },
  metric_chart: {
    kind: 'metric_chart',
    specVersion: 1,
    payload: {
      title: 'Nifty breadth',
      suggestedViz: 'line',
      series: [{ name: 'advancers', points: [{ x: '09:15', y: 12 }] }],
    },
  },
  recommend_actions: {
    kind: 'recommend_actions',
    specVersion: 1,
    payload: {
      question: 'What next?',
      actions: [{ label: 'Show the losers', prompt: 'List the ten worst performers today.' }],
    },
  },
  canvas: {
    kind: 'canvas',
    specVersion: 1,
    payload: { title: 'Sector matrix', html: '<div id="root">matrix</div>' },
  },
} as const satisfies Record<string, CardEnvelope>;

describe('card renderers', () => {
  it('renders a text card as markdown', () => {
    const html = render(CARDS.text);
    expect(html).toContain('Summary');
    expect(html).toContain('<strong');
    expect(html).toContain('breadth');
  });

  it('renders a code card with its language chip', () => {
    const html = render(CARDS.code);
    expect(html).toContain('select 1 from dual');
    expect(html).toContain('sql');
    expect(html).toContain('query.sql');
  });

  it('renders an alert with an icon as well as a severity color', () => {
    const html = render(CARDS.alert);
    expect(html).toContain('Prices are 40 minutes old.');
    expect(html).toContain('card-alert-warning');
    // Severity must never be carried by color alone.
    expect(html).toContain('aria-label="Warning"');
    expect(html).toContain('<svg');
  });

  it('renders a detail card as a key/value grid with its status chip', () => {
    const html = render(CARDS.detail);
    expect(html).toContain('Order 4471');
    expect(html).toContain('settled');
    expect(html).toContain('Notional');
    expect(html).toContain('₹1,20,000');
  });

  it('renders an item list with a labelled status dot and the id as plain text', () => {
    const html = render(CARDS.item_list);
    expect(html).toContain('Infosys');
    expect(html).toContain('card-status-warn');
    expect(html).toContain('aria-label="Warning"');
    // The id is an identifier, not a link.
    expect(html).toContain('NSE:INFY');
    expect(html).not.toContain('<a ');
  });

  it('renders a data table with numeric alignment, totals and caption', () => {
    const html = render(CARDS.data_table);
    expect(html).toContain('Banks');
    expect(html).toContain('card-table-numeric');
    expect(html).toContain('card-table-totals');
    expect(html).toContain('Source: NSE bhavcopy');
    expect(html).toContain('card-table-scroll');
  });

  it('renders a metric chart shell without pulling echarts into the render', () => {
    const html = render(CARDS.metric_chart);
    expect(html).toContain('Nifty breadth');
  });

  it('renders recommend_actions pills', () => {
    const html = render(CARDS.recommend_actions);
    expect(html).toContain('What next?');
    expect(html).toContain('Show the losers');
    expect(html).toContain('empty-state-pill');
  });

  it('renders a canvas host as a sandboxed iframe', () => {
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(CanvasBlock, { card: CARDS.canvas }),
      ),
    );
    expect(html).toContain('Sector matrix');
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain('allow-same-origin');
    // The srcdoc lands HTML-escaped inside the attribute.
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('default-src &#x27;none&#x27;');
  });
});

describe('card registry fallback', () => {
  it('routes an unknown kind to the fallback', () => {
    expect(resolveCardRenderer('sector_heatmap', 1)).toBe(UnknownCardBlock);
  });

  it('routes a known kind at an unsupported spec version to the fallback', () => {
    expect(resolveCardRenderer('text', 2)).toBe(UnknownCardBlock);
  });

  it('the fallback names the kind and keeps the payload inspectable', () => {
    // Shaped like an envelope from a newer server than this client.
    const future = { kind: 'sector_heatmap', specVersion: 7, payload: { rows: 3 } };
    const html = renderToStaticMarkup(
      createElement(UnknownCardBlock, { card: future as unknown as CardEnvelope }),
    );
    expect(html).toContain('sector_heatmap');
    expect(html).toContain('spec v7');
    expect(html).toContain('&quot;rows&quot;: 3');
  });
});

describe('metric chart option', () => {
  it('honours suggestedViz when it maps to a registered series type', () => {
    const option = buildMetricChartOption({
      suggestedViz: 'area',
      series: [{ name: 'a', points: [{ x: 1, y: 2 }] }],
    });
    const series = option.series as Array<Record<string, unknown>>;
    expect(series[0]?.type).toBe('line');
    expect(series[0]?.areaStyle).toEqual({});
  });

  it('shares one category axis across up to four series', () => {
    const option = buildMetricChartOption({
      series: [
        { name: 'a', points: [{ x: 'Mon', y: 1 }] },
        { name: 'b', points: [{ x: 'Tue', y: 4 }] },
      ],
    });
    expect(option.xAxis).toMatchObject({ type: 'category', data: ['Mon', 'Tue'] });
    const series = option.series as Array<Record<string, unknown>>;
    expect(series).toHaveLength(2);
    expect(series[0]?.data).toEqual([1, null]);
  });
});

describe('canvas srcdoc', () => {
  const build = (payload: { html: string; data?: unknown; librarySources?: string[] }) =>
    buildCanvasSrcDoc({ ...payload, tokens: DEFAULT_TOKENS });

  it('carries the network-blocking CSP meta', () => {
    const doc = build({ html: '<p>hi</p>' });
    expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="${CANVAS_CSP}">`);
    expect(CANVAS_CSP).toContain("default-src 'none'");
    expect(CANVAS_CSP).not.toContain('connect-src');
  });

  it('injects the data as a frozen global', () => {
    const doc = build({ html: '<p>hi</p>', data: { rows: [1, 2] } });
    expect(doc).toContain(`Object.defineProperty(window, '${CANVAS_DATA_GLOBAL}'`);
    expect(doc).toContain('Object.freeze(node)');
    expect(doc).toContain('"rows":[1,2]');
  });

  it('a payload containing </script> cannot break out of the script tag', () => {
    const doc = build({ html: '<p>hi</p>', data: { note: '</script><script>alert(1)</script>' } });
    expect(doc).not.toContain('</script><script>alert(1)');
    // Escaping `<` is enough: the HTML parser only ends a script block at a
    // literal `</script`, and `<` cannot survive in the embedded JSON.
    expect(doc).toContain('\\u003c/script>');
    expect(JSON.parse('"\\u003c/script>"')).toBe('</script>');
  });

  it('prepends allowlisted library sources ahead of the template body', () => {
    const doc = build({ html: '<div id="tpl"></div>', librarySources: ['var echartsStub = 1;'] });
    expect(doc.indexOf('var echartsStub = 1;')).toBeLessThan(doc.indexOf('<div id="tpl">'));
  });
});

describe('recommend_actions pill click', () => {
  it('calls the composer-injection callback with the exact prompt', () => {
    const onPick = vi.fn();
    const tree = ActionPills({
      actions: [
        { label: 'Show the losers', prompt: 'List the ten worst performers today.' },
        { label: 'Compare sectors', prompt: 'Compare sector flows week over week.' },
      ],
      disabled: false,
      onPick,
    });
    const pill = findPill(tree, 'Compare sectors');
    pill.props.onClick();
    expect(onPick).toHaveBeenCalledWith('Compare sector flows week over week.');
  });

  it('disables the pills once the question is settled', () => {
    const tree = ActionPills({
      actions: [{ label: 'Show the losers', prompt: 'p' }],
      disabled: true,
      onPick: () => {},
    });
    expect(findPill(tree, 'Show the losers').props.disabled).toBe(true);
  });
});

type PillElement = ReactElement<{
  children: ReactNode;
  disabled: boolean;
  onClick: () => void;
}>;

function findPill(tree: ReactNode, label: string): PillElement {
  const container = tree as ReactElement<{ children: ReactNode }>;
  const children = container.props.children;
  const pills = (Array.isArray(children) ? children : [children]).filter(isValidElement);
  const match = pills.find((pill) => (pill as PillElement).props.children === label);
  if (!match) throw new Error(`no pill labelled ${label}`);
  return match as PillElement;
}
