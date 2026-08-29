import { type CardEnvelope, CardEnvelopeSchema } from '@ethosagent/web-contracts';

// Broadcast gate for typed UI cards (plan/phases/ui-cards-canvas.md B1).
//
// A tool puts its card on `ToolResult.structured.card`. The client renders
// that envelope by `kind`, so an envelope that does not match the contract is
// not a rendering problem to solve downstream — it is a payload that must
// never reach the wire. The gate is the single place that decides, and it is
// pure so both the stream path and the tests can call it.
//
// Everything else in `structured` (the legacy `_uiType` image/html/pdf path,
// tool-specific extras) passes through untouched.

export interface GatedStructured {
  /** What to broadcast, with an invalid `card` removed. Absent when empty. */
  structured?: Record<string, unknown>;
  /** The validated envelope, when there was a valid one. */
  card?: CardEnvelope;
  /** Present only when a `card` key was rejected. Paths into the envelope. */
  issues?: string[];
}

export function gateStructuredCard(
  structured: Record<string, unknown> | undefined,
): GatedStructured {
  if (structured === undefined) return {};
  if (!('card' in structured)) return { structured };

  const parsed = CardEnvelopeSchema.safeParse(structured.card);
  if (parsed.success) return { structured, card: parsed.data };

  const { card: _rejected, ...rest } = structured;
  return {
    // A `structured` whose only key was the rejected card carries nothing —
    // omit it rather than broadcasting an empty object.
    ...(Object.keys(rest).length > 0 ? { structured: rest } : {}),
    issues: parsed.error.issues.map((issue) => {
      // `String(...)` per segment: zod paths are PropertyKey[], and Array.join
      // throws on a symbol segment.
      const path = ['card', ...issue.path.map((segment) => String(segment))].join('.');
      return `${path}: ${issue.message}`;
    }),
  };
}
