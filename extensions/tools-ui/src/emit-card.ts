import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';
import {
  CARD_SPEC_VERSION,
  EMIT_CARD_KINDS,
  EMIT_CARD_PAYLOAD_SCHEMAS,
  type EmitCardKind,
} from '@ethosagent/web-contracts';
import { isUiPlatform, offSurfaceRefusal } from './ui-platform';
import { issueField, issueLines } from './zod-issues';

export interface EmitCardArgs {
  kind: EmitCardKind;
  payload: unknown;
}

// Hand-written, not derived: the full JSON Schema of all eight payloads is
// several thousand characters and this description ships in every prompt. The
// per-field caps and hints live in the zod source (web-contracts/src/cards.ts)
// and are enforced there; this is the one-line-per-kind shape reminder that
// gets the model to the right kind.
const DESCRIPTION = `Render a typed UI card on the web surface. Cards are additive: always give the full answer in prose too — a card never replaces the explanation.

Pick the kind that matches the shape of the data:
- text: { title?, text } — markdown body, max 8000 chars.
- code: { title?, language?, code } — unfenced source, max 16000 chars.
- alert: { severity: info|success|warning|error, title?, message } — message max 500 chars.
- detail: { title, status?, fields[{label,value}] } — one record, 1-12 fields.
- item_list: { title?, items[{id,name,status?,meta?}] } — a set of like things, 1-50 items; id is a stable identifier, never a URL.
- data_table: { title?, caption?, columns[{key,label,numeric?}], rows[] keyed by column key, totals? } — max 8 columns x 50 rows.
- metric_chart: { title?, suggestedViz?, xLabel?, yLabel?, series[{name,points[{x,y}]}] } — 1-4 series, max 200 points each.
- recommend_actions: { question?, actions[{label,prompt}] } — 1-3 follow-ups; emit last in a turn and only when a genuine next step exists.

Payloads are data, never presentation: no colors, no HTML, no chart specs, no URLs. The client decides how it looks.`;

/** `title` is the only field the ack line borrows; not every kind has one. */
function titleOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const title = (payload as { title?: unknown }).title;
  return typeof title === 'string' && title.length > 0 ? title : undefined;
}

export const emitCardTool: Tool<EmitCardArgs> = {
  name: 'emit_card',
  description: DESCRIPTION,
  toolset: 'ui',
  maxResultChars: 200,
  capabilities: {},
  schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: [...EMIT_CARD_KINDS],
        description: 'Which card kind to render.',
      },
      // Deliberately untyped here rather than a per-kind `oneOf`: provider
      // support for conditional sub-schemas varies, and a rejected tool
      // definition is worse than a rejected call. The real check is the zod
      // parse below, whose issues come back as field-level repair feedback.
      payload: {
        type: 'object',
        description: 'Card payload. Its fields depend on `kind` — see the tool description.',
      },
    },
    required: ['kind', 'payload'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    if (!isUiPlatform(ctx.platform)) return offSurfaceRefusal();

    const kind = args?.kind;
    if (typeof kind !== 'string' || !(EMIT_CARD_KINDS as readonly string[]).includes(kind)) {
      return {
        ok: false,
        code: 'input_invalid',
        error: `Unknown card kind ${JSON.stringify(kind)}. Use one of: ${EMIT_CARD_KINDS.join(', ')}.`,
        field: 'kind',
      };
    }

    const parsed = EMIT_CARD_PAYLOAD_SCHEMAS[kind as EmitCardKind].safeParse(args.payload);
    if (!parsed.success) {
      const { issues } = parsed.error;
      return {
        ok: false,
        code: 'input_invalid',
        error: `Invalid payload for card kind "${kind}":\n${issueLines(issues)}`,
        field: issueField(issues, 'payload'),
      };
    }

    // `value` is an ack, never the payload — history stays cheap and the card
    // itself travels on `structured`.
    const title = titleOf(parsed.data);
    return {
      ok: true,
      value: `rendered: ${kind}${title ? `: ${title}` : ''}`,
      structured: {
        card: { kind, specVersion: CARD_SPEC_VERSION, payload: parsed.data },
      },
    };
  },
};
