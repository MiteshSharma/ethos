import { z } from 'zod';

// Typed UI cards — the canonical schema home (plan/phases/ui-cards-canvas.md).
//
// Payloads are DATA-SHAPED, never presentation-shaped. No colors, no HTML, no
// chart-library specs, no URLs. The model describes what the data *is*; the
// client decides how it looks. The `emit_card` tool derives its JSON-schema
// args from these zod sources (see `cardPayloadJsonSchema`), so the tool
// validator and the wire type cannot drift.
//
// Every field carries a `.describe()` hint aimed at the model that fills it in
// — these strings ship to the LLM as part of the tool definition.

/** Envelope version. Bump when a payload shape changes incompatibly. */
export const CARD_SPEC_VERSION = 1;

// ---------------------------------------------------------------------------
// Payload schemas — the eight model-emittable kinds
// ---------------------------------------------------------------------------

export const TextCardPayloadSchema = z.object({
  title: z.string().max(120).optional().describe('Optional short heading.'),
  text: z.string().min(1).max(8000).describe('Markdown body. Max 8000 characters.'),
});
export type TextCardPayload = z.infer<typeof TextCardPayloadSchema>;

export const CodeCardPayloadSchema = z.object({
  title: z.string().max(120).optional().describe('Optional short heading, e.g. the file name.'),
  language: z
    .string()
    .max(32)
    .optional()
    .describe('Language identifier for highlighting, e.g. "typescript", "sql".'),
  code: z.string().min(1).max(16000).describe('Source text, unfenced. Max 16000 characters.'),
});
export type CodeCardPayload = z.infer<typeof CodeCardPayloadSchema>;

export const AlertCardPayloadSchema = z.object({
  severity: z
    .enum(['info', 'success', 'warning', 'error'])
    .describe('How serious this is. Drives the icon and tone the client renders.'),
  title: z.string().max(120).optional().describe('Optional short heading.'),
  message: z.string().min(1).max(500).describe('One or two sentences. Max 500 characters.'),
});
export type AlertCardPayload = z.infer<typeof AlertCardPayloadSchema>;

export const DetailCardPayloadSchema = z.object({
  title: z.string().min(1).max(120).describe('What this record is.'),
  status: z.string().max(40).optional().describe('Short state word, e.g. "open", "settled".'),
  fields: z
    .array(
      z.object({
        label: z.string().min(1).max(60).describe('Field name.'),
        value: z.string().min(1).max(500).describe('Field value as display text.'),
      }),
    )
    .min(1)
    .max(12)
    .describe('Key/value pairs describing one entity. 1-12 entries.'),
});
export type DetailCardPayload = z.infer<typeof DetailCardPayloadSchema>;

export const ItemListCardPayloadSchema = z.object({
  title: z.string().max(120).optional().describe('Optional short heading.'),
  items: z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .max(120)
          .describe('Stable identifier, NOT a URL — the client turns it into a link.'),
        name: z.string().min(1).max(200).describe('Primary label for the item.'),
        status: z
          .enum(['ok', 'warn', 'error', 'neutral'])
          .optional()
          .describe('Coarse state, rendered as a status dot.'),
        meta: z.string().max(200).optional().describe('One short secondary line.'),
      }),
    )
    .min(1)
    .max(50)
    .describe('One resource shape per list. 1-50 items.'),
});
export type ItemListCardPayload = z.infer<typeof ItemListCardPayloadSchema>;

/** A single table cell. Numbers stay numbers so the client can align them. */
const TableCellSchema = z.union([z.string(), z.number(), z.null()]);

export const DataTableCardPayloadSchema = z.object({
  title: z.string().max(120).optional().describe('Optional short heading.'),
  caption: z.string().max(300).optional().describe('Short note below the table, e.g. the source.'),
  columns: z
    .array(
      z.object({
        key: z.string().min(1).max(60).describe('Key used to look the value up in each row.'),
        label: z.string().min(1).max(60).describe('Column header text.'),
        numeric: z.boolean().optional().describe('Right-align + tabular numerals.'),
      }),
    )
    .min(1)
    .max(8)
    .describe('Column definitions. 1-8 columns.'),
  rows: z
    .array(z.record(z.string(), TableCellSchema))
    .max(50)
    .describe('Objects keyed by `columns[].key`. Up to 50 rows.'),
  totals: z
    .record(z.string(), TableCellSchema)
    .optional()
    .describe('Optional summary row, keyed by `columns[].key`.'),
});
export type DataTableCardPayload = z.infer<typeof DataTableCardPayloadSchema>;

export const MetricChartCardPayloadSchema = z.object({
  title: z.string().max(120).optional().describe('Optional short heading.'),
  suggestedViz: z
    .enum(['line', 'bar', 'area', 'scatter'])
    .optional()
    .describe('Advisory only; the client decides the final visual form.'),
  xLabel: z.string().max(60).optional().describe('Axis label for x.'),
  yLabel: z.string().max(60).optional().describe('Axis label for y, including the unit.'),
  series: z
    .array(
      z.object({
        name: z.string().min(1).max(60).describe('Series name shown in the legend.'),
        points: z
          .array(
            z.object({
              x: z
                .union([z.string(), z.number()])
                .describe('Category label or numeric/ISO-date position.'),
              y: z.number().describe('Measured value.'),
            }),
          )
          .min(1)
          .max(200)
          .describe('Ordered points. 1-200 per series.'),
      }),
    )
    .min(1)
    .max(4)
    .describe('1-4 series sharing the same axes and unit.'),
});
export type MetricChartCardPayload = z.infer<typeof MetricChartCardPayloadSchema>;

export const RecommendActionsCardPayloadSchema = z.object({
  question: z
    .string()
    .max(200)
    .optional()
    .describe('What the user is being asked to pick between.'),
  actions: z
    .array(
      z.object({
        label: z.string().min(1).max(60).describe('Short pill text.'),
        prompt: z
          .string()
          .min(1)
          .max(500)
          .describe('The exact text injected into the composer when the user picks this action.'),
      }),
    )
    .min(1)
    .max(3)
    .describe('1-3 follow-ups. Put this card last in a turn.'),
});
export type RecommendActionsCardPayload = z.infer<typeof RecommendActionsCardPayloadSchema>;

// ---------------------------------------------------------------------------
// Canvas — NOT emittable via `emit_card`; produced by `render_ui` only
// ---------------------------------------------------------------------------

/** Versioned allowlist of libraries bundled locally by the web app. No CDN. */
export const CANVAS_LIBRARIES = ['echarts@1'] as const;
export type CanvasLibrary = (typeof CANVAS_LIBRARIES)[number];

export const CanvasCardPayloadSchema = z.object({
  title: z.string().max(120).optional().describe('Optional short heading.'),
  html: z
    .string()
    .min(1)
    .max(65536)
    .describe('Document body rendered in a sandboxed iframe. Max 65536 characters.'),
  data: z.unknown().optional().describe('JSON value injected as a frozen global for the template.'),
  libraries: z
    .array(z.enum(CANVAS_LIBRARIES))
    .max(4)
    .optional()
    .describe('Allowlisted local bundles to prepend. Unknown names are rejected.'),
});
export type CanvasCardPayload = z.infer<typeof CanvasCardPayloadSchema>;

// ---------------------------------------------------------------------------
// Registry + envelope
// ---------------------------------------------------------------------------

export const EMIT_CARD_KINDS = [
  'text',
  'code',
  'alert',
  'detail',
  'item_list',
  'data_table',
  'metric_chart',
  'recommend_actions',
] as const;
export type EmitCardKind = (typeof EMIT_CARD_KINDS)[number];

/** kind -> payload schema, for the eight model-emittable kinds. */
export const EMIT_CARD_PAYLOAD_SCHEMAS: { readonly [K in EmitCardKind]: z.ZodType } = {
  text: TextCardPayloadSchema,
  code: CodeCardPayloadSchema,
  alert: AlertCardPayloadSchema,
  detail: DetailCardPayloadSchema,
  item_list: ItemListCardPayloadSchema,
  data_table: DataTableCardPayloadSchema,
  metric_chart: MetricChartCardPayloadSchema,
  recommend_actions: RecommendActionsCardPayloadSchema,
};

const envelope = <K extends string, P extends z.ZodType>(kind: K, payload: P) =>
  z.object({
    kind: z.literal(kind),
    specVersion: z.literal(CARD_SPEC_VERSION),
    payload,
  });

export const CardEnvelopeSchema = z.discriminatedUnion('kind', [
  envelope('text', TextCardPayloadSchema),
  envelope('code', CodeCardPayloadSchema),
  envelope('alert', AlertCardPayloadSchema),
  envelope('detail', DetailCardPayloadSchema),
  envelope('item_list', ItemListCardPayloadSchema),
  envelope('data_table', DataTableCardPayloadSchema),
  envelope('metric_chart', MetricChartCardPayloadSchema),
  envelope('recommend_actions', RecommendActionsCardPayloadSchema),
  envelope('canvas', CanvasCardPayloadSchema),
]);
export type CardEnvelope = z.infer<typeof CardEnvelopeSchema>;

/** Every envelope kind, including `canvas` (which `emit_card` cannot produce). */
export type CardKind = CardEnvelope['kind'];

// ---------------------------------------------------------------------------
// JSON-Schema derivation — the tool's args come from here, so they cannot drift
// ---------------------------------------------------------------------------

const jsonSchemaCache = new Map<EmitCardKind, Record<string, unknown>>();

/** JSON Schema for one card kind's payload, derived from the zod source. */
export function cardPayloadJsonSchema(kind: EmitCardKind): Record<string, unknown> {
  const cached = jsonSchemaCache.get(kind);
  if (cached) return cached;

  const derived = z.toJSONSchema(EMIT_CARD_PAYLOAD_SCHEMAS[kind], {
    target: 'draft-7',
  }) as Record<string, unknown>;
  // `$schema` is metadata; Anthropic/OpenAI tool parameter schemas reject it.
  delete derived.$schema;

  jsonSchemaCache.set(kind, derived);
  return derived;
}

// ---------------------------------------------------------------------------
// Replay record
// ---------------------------------------------------------------------------

export const SessionCardSchema = z.object({
  toolCallId: z.string(),
  /** Monotonic per-session ordering key. */
  seq: z.number().int().nonnegative(),
  envelope: CardEnvelopeSchema,
});
export type SessionCard = z.infer<typeof SessionCardSchema>;
