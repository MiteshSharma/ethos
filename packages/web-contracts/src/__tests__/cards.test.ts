import { describe, expect, it } from 'vitest';
import {
  CARD_SPEC_VERSION,
  CardEnvelopeSchema,
  cardPayloadJsonSchema,
  EMIT_CARD_KINDS,
  EMIT_CARD_PAYLOAD_SCHEMAS,
  SessionCardSchema,
} from '../cards';

// Card payloads are data-shaped and capped IN THE SCHEMA (decision table in
// plan/phases/ui-cards-canvas.md). These tests lock the caps at the boundary,
// the envelope's version discriminator, and the JSON-schema derivation the
// `emit_card` tool's args are built from.

const wrap = (kind: string, payload: unknown) => ({
  kind,
  specVersion: CARD_SPEC_VERSION,
  payload,
});
const chars = (n: number) => 'x'.repeat(n);
const range = <T>(n: number, make: (i: number) => T): T[] =>
  Array.from({ length: n }, (_, i) => make(i));

const MINIMAL: Record<string, unknown> = {
  text: { text: 'hello' },
  code: { code: 'const a = 1;' },
  alert: { severity: 'info', message: 'heads up' },
  detail: { title: 'Order', fields: [{ label: 'Ticker', value: 'INFY' }] },
  item_list: { items: [{ id: 'inf-1', name: 'Infosys' }] },
  data_table: { columns: [{ key: 'a', label: 'A' }], rows: [] },
  metric_chart: { series: [{ name: 'close', points: [{ x: '2026-01-01', y: 1 }] }] },
  recommend_actions: { actions: [{ label: 'Dig in', prompt: 'Show me the breadth matrix' }] },
  canvas: { html: '<p>hi</p>' },
};

const MAXIMAL: Record<string, unknown> = {
  text: { title: chars(120), text: chars(8000) },
  code: { title: chars(120), language: chars(32), code: chars(16000) },
  alert: { severity: 'error', title: chars(120), message: chars(500) },
  detail: {
    title: chars(120),
    status: chars(40),
    fields: range(12, (i) => ({ label: `l${i}`, value: chars(500) })),
  },
  item_list: {
    title: chars(120),
    items: range(50, (i) => ({
      id: `id-${i}`,
      name: chars(200),
      status: 'warn',
      meta: chars(200),
    })),
  },
  data_table: {
    title: chars(120),
    caption: chars(300),
    columns: range(8, (i) => ({ key: `c${i}`, label: `C${i}`, numeric: true })),
    rows: range(50, (i) => ({ c0: 'text', c1: i, c2: null })),
    totals: { c1: 1225 },
  },
  metric_chart: {
    title: chars(120),
    suggestedViz: 'scatter',
    xLabel: chars(60),
    yLabel: chars(60),
    series: range(4, (s) => ({
      name: `s${s}`,
      points: range(200, (p) => ({ x: p, y: p * 1.5 })),
    })),
  },
  recommend_actions: {
    question: chars(200),
    actions: range(3, (i) => ({ label: `a${i}`, prompt: chars(500) })),
  },
  canvas: {
    title: chars(120),
    html: chars(65536),
    data: { any: ['shape'] },
    libraries: ['echarts@1'],
  },
};

const ALL_KINDS = Object.keys(MINIMAL);

describe('CardEnvelopeSchema', () => {
  for (const kind of ALL_KINDS) {
    it(`round-trips a minimal ${kind} payload`, () => {
      const input = wrap(kind, MINIMAL[kind]);
      const parsed = CardEnvelopeSchema.parse(input);
      expect(parsed).toEqual(input);
    });

    it(`round-trips a maximal ${kind} payload`, () => {
      const input = wrap(kind, MAXIMAL[kind]);
      expect(CardEnvelopeSchema.safeParse(input).success).toBe(true);
    });
  }

  it('covers exactly the eight emittable kinds plus canvas', () => {
    expect(ALL_KINDS).toEqual([...EMIT_CARD_KINDS, 'canvas']);
  });

  it('rejects a mismatched specVersion', () => {
    const bad = { kind: 'text', specVersion: 2, payload: { text: 'hi' } };
    expect(CardEnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown kind', () => {
    const bad = wrap('sparkline', { text: 'hi' });
    expect(CardEnvelopeSchema.safeParse(bad).success).toBe(false);
  });
});

describe('caps reject at boundary + 1', () => {
  const overflows: Array<[string, string, unknown]> = [
    [
      '9 columns',
      'data_table',
      {
        columns: range(9, (i) => ({ key: `c${i}`, label: `C${i}` })),
        rows: [],
      },
    ],
    [
      '51 rows',
      'data_table',
      {
        columns: [{ key: 'c0', label: 'C0' }],
        rows: range(51, () => ({ c0: 'v' })),
      },
    ],
    [
      '5 series',
      'metric_chart',
      {
        series: range(5, (s) => ({ name: `s${s}`, points: [{ x: 0, y: 0 }] })),
      },
    ],
    [
      '201 points',
      'metric_chart',
      {
        series: [{ name: 's', points: range(201, (p) => ({ x: p, y: p })) }],
      },
    ],
    ['51 items', 'item_list', { items: range(51, (i) => ({ id: `i${i}`, name: `n${i}` })) }],
    [
      '4 actions',
      'recommend_actions',
      {
        actions: range(4, (i) => ({ label: `a${i}`, prompt: `p${i}` })),
      },
    ],
    ['0 actions', 'recommend_actions', { actions: [] }],
    ['8001-char text', 'text', { text: chars(8001) }],
    ['16001-char code', 'code', { code: chars(16001) }],
    ['501-char alert message', 'alert', { severity: 'info', message: chars(501) }],
    [
      '13 detail fields',
      'detail',
      {
        title: 'Order',
        fields: range(13, (i) => ({ label: `l${i}`, value: `v${i}` })),
      },
    ],
    ['65537-char canvas html', 'canvas', { html: chars(65537) }],
  ];

  for (const [label, kind, payload] of overflows) {
    it(`rejects ${label}`, () => {
      expect(CardEnvelopeSchema.safeParse(wrap(kind, payload)).success).toBe(false);
    });
  }
});

describe('cardPayloadJsonSchema', () => {
  it('derives a usable object schema for data_table', () => {
    const schema = cardPayloadJsonSchema('data_table');
    expect(schema.type).toBe('object');
    const properties = schema.properties as Record<string, unknown>;
    expect(properties.columns).toBeDefined();
  });

  it('omits the $schema metadata key so it can be used as tool params', () => {
    expect(cardPayloadJsonSchema('text')).not.toHaveProperty('$schema');
  });

  it('caches — repeated calls return the same object', () => {
    expect(cardPayloadJsonSchema('alert')).toBe(cardPayloadJsonSchema('alert'));
  });

  it('derives a schema for every emittable kind', () => {
    for (const kind of EMIT_CARD_KINDS) {
      expect(cardPayloadJsonSchema(kind).type).toBe('object');
    }
  });
});

describe('registry drift guard', () => {
  it('EMIT_CARD_KINDS has exactly 8 entries', () => {
    expect(EMIT_CARD_KINDS).toHaveLength(8);
  });

  it('EMIT_CARD_PAYLOAD_SCHEMAS has a key for each kind and no extras', () => {
    expect(Object.keys(EMIT_CARD_PAYLOAD_SCHEMAS).sort()).toEqual([...EMIT_CARD_KINDS].sort());
  });
});

describe('SessionCardSchema', () => {
  it('accepts a replay record', () => {
    const record = {
      toolCallId: 'toolu_1',
      seq: 0,
      envelope: wrap('text', { text: 'hi' }),
    };
    expect(SessionCardSchema.parse(record)).toEqual(record);
  });

  it('rejects a negative seq', () => {
    const bad = { toolCallId: 't', seq: -1, envelope: wrap('text', { text: 'hi' }) };
    expect(SessionCardSchema.safeParse(bad).success).toBe(false);
  });
});
