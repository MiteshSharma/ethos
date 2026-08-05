// Lane 4a — the repair-harness delta (plan/phases/local-llm-excellence.md,
// "The repair harness — scope to the delta only"). Ethos already has stage 1
// (lenient parse, json-repair.ts) and the presence half of stage 3 (required-
// fields re-check, tool-rejection.ts). This module adds the missing pieces:
//
//   Stage 2 — conservative schema-based TYPE COERCION for REPAIRED tool
//   arguments: string "5" for a number field, string "true" for a boolean
//   field, a single value for an array-of field. Exactly those three shapes —
//   nothing lossy, nothing clever (no comma-splitting, no nested descent).
//
//   Stage 3 (delta) — PER-FIELD validation feedback: when a repaired call is
//   rejected, the message names the specific offending field(s) and expected
//   type(s) so the model can retry precisely, instead of a generic error.
//
// Like `missingRequiredFields`, this only inspects TOP-LEVEL properties and
// only runs on the REPAIRED path — clean strict-parse args are never routed
// here (a deliberate §4 decision, asserted by malformed-tool-args.test.ts).

export interface FieldMismatch {
  field: string;
  expected: string;
  got: string;
}

export interface CoercionResult {
  /** The (possibly coerced) arguments. A new object when args was a plain
   *  object; the original value otherwise. */
  args: unknown;
  /** Top-level fields whose value still mismatches the declared schema type
   *  after the coercion attempt. */
  mismatches: FieldMismatch[];
}

/**
 * Coerce a repaired argument object toward the tool's JSON schema. Only
 * top-level properties with a single declared `type` string are considered;
 * union types, missing types, and non-object args pass through untouched.
 */
export function coerceArgsToSchema(schema: Record<string, unknown>, args: unknown): CoercionResult {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { args, mismatches: [] };
  }
  const properties = schema.properties;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return { args, mismatches: [] };
  }
  const obj = args as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };
  const mismatches: FieldMismatch[] = [];

  for (const [key, propSchema] of Object.entries(properties as Record<string, unknown>)) {
    if (!(key in obj) || obj[key] === undefined) continue;
    if (typeof propSchema !== 'object' || propSchema === null || Array.isArray(propSchema)) {
      continue;
    }
    const expected = (propSchema as Record<string, unknown>).type;
    if (typeof expected !== 'string') continue; // union / absent type — not validated
    const value = obj[key];
    if (typeMatches(expected, value)) continue;

    const coerced = coerceValue(expected, value, propSchema as Record<string, unknown>);
    if (coerced.ok) {
      out[key] = coerced.value;
    } else {
      mismatches.push({ field: key, expected, got: describeType(value) });
    }
  }

  return { args: out, mismatches };
}

/**
 * Per-field rejection message (stage-3 delta) for a repaired call that failed
 * validation. Names every offending field with its expected type — and, for
 * type mismatches, the type actually received — so the model's retry can fix
 * the exact field instead of guessing at a generic parse error.
 */
export function describeRepairedArgsFailure(
  schema: Record<string, unknown>,
  missing: string[],
  mismatches: FieldMismatch[],
): string {
  const parts: string[] = [];
  if (missing.length > 0) {
    const list = missing.map((field) => {
      const expected = declaredTypeOf(schema, field);
      return expected !== undefined ? `${field} (expected ${expected})` : field;
    });
    parts.push(`missing required field(s): ${list.join(', ')}`);
  }
  if (mismatches.length > 0) {
    const list = mismatches.map((m) => `${m.field} (expected ${m.expected}, got ${m.got})`);
    parts.push(`wrong-typed field(s): ${list.join(', ')}`);
  }
  return `repaired tool arguments failed validation — ${parts.join('; ')}`;
}

function declaredTypeOf(schema: Record<string, unknown>, field: string): string | undefined {
  const properties = schema.properties;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return undefined;
  }
  const propSchema = (properties as Record<string, unknown>)[field];
  if (typeof propSchema !== 'object' || propSchema === null || Array.isArray(propSchema)) {
    return undefined;
  }
  const t = (propSchema as Record<string, unknown>).type;
  return typeof t === 'string' ? t : undefined;
}

function typeMatches(expected: string, value: unknown): boolean {
  switch (expected) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true; // unknown schema type — do not validate
  }
}

function coerceValue(
  expected: string,
  value: unknown,
  propSchema: Record<string, unknown>,
): { ok: true; value: unknown } | { ok: false } {
  // string "5" → number 5 (integer fields additionally require an integral value)
  if ((expected === 'number' || expected === 'integer') && typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return { ok: false };
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return { ok: false };
    if (expected === 'integer' && !Number.isInteger(n)) return { ok: false };
    return { ok: true, value: n };
  }
  // string "true"/"false" → boolean
  if (expected === 'boolean' && typeof value === 'string') {
    const t = value.trim().toLowerCase();
    if (t === 'true') return { ok: true, value: true };
    if (t === 'false') return { ok: true, value: false };
    return { ok: false };
  }
  // single value → one-element array, only when the value already matches the
  // declared item type (or no item type is declared). No element coercion.
  if (expected === 'array') {
    const items = propSchema.items;
    if (typeof items === 'object' && items !== null && !Array.isArray(items)) {
      const itemType = (items as Record<string, unknown>).type;
      if (typeof itemType === 'string' && !typeMatches(itemType, value)) {
        return { ok: false };
      }
    }
    return { ok: true, value: [value] };
  }
  return { ok: false };
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
