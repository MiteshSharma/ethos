// `emit_card` is the only door onto the eight typed card kinds. These tests pin
// the three things the rest of the pipeline trusts: the envelope it stamps
// parses against the wire schema, invalid payloads come back with issue PATHS
// (so the loop's repair machinery can teach the model), and the ack line never
// carries the payload into history.

import type { ToolContext } from '@ethosagent/types';
import {
  CARD_SPEC_VERSION,
  CardEnvelopeSchema,
  EMIT_CARD_KINDS,
  type EmitCardKind,
} from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { emitCardTool } from '../emit-card';

const ctx = { platform: 'web' } as unknown as ToolContext;

const PAYLOADS: { [K in EmitCardKind]: Record<string, unknown> } = {
  text: { title: 'Summary', text: 'The market closed flat.' },
  code: { title: 'query.sql', language: 'sql', code: 'select 1;' },
  alert: { severity: 'warning', title: 'Stale data', message: 'Feed is 20 minutes behind.' },
  detail: {
    title: 'INFY',
    status: 'open',
    fields: [{ label: 'Entry', value: '1,540' }],
  },
  item_list: {
    title: 'Watchlist',
    items: [{ id: 'infy', name: 'Infosys', status: 'ok', meta: '+1.2%' }],
  },
  data_table: {
    title: 'Sectors',
    columns: [
      { key: 'sector', label: 'Sector' },
      { key: 'flow', label: 'Flow', numeric: true },
    ],
    rows: [{ sector: 'IT', flow: 12.5 }],
  },
  metric_chart: {
    title: 'Breadth',
    suggestedViz: 'line',
    series: [{ name: 'Advances', points: [{ x: '2026-08-10', y: 1200 }] }],
  },
  recommend_actions: {
    question: 'What next?',
    actions: [{ label: 'Show losers', prompt: 'Show me the biggest losers today.' }],
  },
};

describe('emit_card emits a wire-valid envelope for every kind', () => {
  for (const kind of EMIT_CARD_KINDS) {
    it(`${kind} round-trips through CardEnvelopeSchema`, async () => {
      const result = await emitCardTool.execute({ kind, payload: PAYLOADS[kind] }, ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const envelope = (result.structured as { card: unknown }).card;
      const parsed = CardEnvelopeSchema.safeParse(envelope);
      expect(parsed.success).toBe(true);
      expect(parsed.data).toMatchObject({ kind, specVersion: CARD_SPEC_VERSION });
    });
  }

  it('is gated by the personality toolset, not always included', () => {
    expect(emitCardTool.toolset).toBe('ui');
    expect(emitCardTool.alwaysInclude).toBeFalsy();
  });
});

describe('emit_card keeps history cheap', () => {
  it('acks with the kind and title, never the payload text', async () => {
    const result = await emitCardTool.execute({ kind: 'text', payload: PAYLOADS.text }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('rendered: text: Summary');
    expect(result.value).not.toContain('The market closed flat');
  });

  it('omits the title when the kind has none', async () => {
    const result = await emitCardTool.execute(
      { kind: 'recommend_actions', payload: PAYLOADS.recommend_actions },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('rendered: recommend_actions');
  });
});

describe('emit_card rejects with repairable detail', () => {
  it('rejects a 9-column data_table and names the offending path', async () => {
    const columns = Array.from({ length: 9 }, (_, i) => ({ key: `c${i}`, label: `C${i}` }));
    const result = await emitCardTool.execute(
      { kind: 'data_table', payload: { columns, rows: [] } },
      ctx,
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'input_invalid',
      field: 'payload.columns',
    });
    if (result.ok) return;
    expect(result.error).toContain('columns:');
  });

  it('names the nested path of a bad field', async () => {
    const result = await emitCardTool.execute(
      { kind: 'detail', payload: { title: 'X', fields: [{ label: 'a' }] } },
      ctx,
    );
    expect(result).toMatchObject({ ok: false, field: 'payload.fields.0.value' });
  });

  it('rejects an unknown kind', async () => {
    const result = await emitCardTool.execute(
      { kind: 'canvas' as unknown as EmitCardKind, payload: { html: '<p>x</p>' } },
      ctx,
    );
    expect(result).toMatchObject({ ok: false, code: 'input_invalid', field: 'kind' });
    if (result.ok) return;
    expect(result.error).toContain('data_table');
  });
});

describe('emit_card off-surface backstop', () => {
  it('refuses politely on a channel platform', async () => {
    const result = await emitCardTool.execute({ kind: 'text', payload: PAYLOADS.text }, {
      platform: 'telegram',
    } as unknown as ToolContext);
    expect(result).toMatchObject({ ok: false, code: 'not_available' });
    if (result.ok) return;
    expect(result.error).toMatch(/prose/i);
  });

  it('renders on desktop', async () => {
    const result = await emitCardTool.execute({ kind: 'text', payload: PAYLOADS.text }, {
      platform: 'desktop',
    } as unknown as ToolContext);
    expect(result.ok).toBe(true);
  });
});
