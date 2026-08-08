// The registry-side twin of the `echarts@1` subset documented in
// skills/document/charts/SKILL.md. The skill teaches the grammar; this filter
// enforces it at the boundary. Both are kept in lockstep by the conformance
// test, which runs the SKILL.md examples through this filter and asserts they
// survive unchanged.
//
// Everything here is pure — no echarts import, so the activation path can
// decide "is this a renderable spec?" without pulling the lazy chunk.

/** Top-level option keys spec 1 allows. Anything else is dropped. */
export const SPEC1_TOP_LEVEL_KEYS = [
  'color',
  'dataset',
  'grid',
  'legend',
  'series',
  'title',
  'tooltip',
  'xAxis',
  'yAxis',
] as const;

/** Series types spec 1 allows. A series of any other type is dropped. */
export const SPEC1_SERIES_TYPES = ['bar', 'line', 'pie', 'scatter', 'heatmap'] as const;

const TOP_LEVEL = new Set<string>(SPEC1_TOP_LEVEL_KEYS);
const SERIES_TYPES = new Set<string>(SPEC1_SERIES_TYPES);

/** Keys that would reach `Object.prototype` if echarts deep-merged them. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Strings that read as code rather than data. `JSON.parse` cannot produce a
 * real function, so the only way a callback smuggles itself into a spec is as
 * a string an option consumer might later evaluate. Spec 1 forbids them
 * outright; the plain-template form (`"{b}: {c}"`) is unaffected.
 */
const FUNCTION_SHAPED =
  /^\s*(?:async\s+)?(?:function\b|new\s+Function\b|\(\s*[^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/;

/**
 * Keys dropped at any depth. Pure JSON is not automatically inert: echarts
 * hands some *data* values straight to the DOM, so the allowlist has to name
 * those sinks too.
 *
 *  • `link` / `sublink` (+ their targets) reach `window.open(link, target)`
 *    from a title click (`echarts/lib/util/format.js` `windowOpen`). Spec 1
 *    says all data is inline and there are no remote references.
 *  • `extraCssText` is concatenated into the tooltip's inline `style`
 *    (`TooltipHTMLContent.js` `assembleCssText`) — raw CSS, not data.
 */
const DENIED_KEYS = new Set(['extraCssText', 'link', 'sublink', 'target', 'subtarget']);

/**
 * Keys whose *string* value echarts writes into `innerHTML`. A string
 * `tooltip.formatter` becomes the tooltip markup verbatim — `formatTpl`
 * escapes the substituted `{b}`/`{c}` values but never the template around
 * them — so `<img src=x onerror=…>` in a fence would run as script in the app
 * origin. Templates that contain no markup are exactly what the skill teaches,
 * so requiring that is faithful to spec 1 rather than a restriction on it.
 */
function isHtmlSinkKey(key: string): boolean {
  return /formatter$/i.test(key) || key === 'className';
}

/**
 * Keys whose string value is concatenated into an inline `style` attribute
 * (`convertToColorString` passes any string through untouched). No legitimate
 * CSS colour contains a declaration separator.
 */
function isCssSinkKey(key: string): boolean {
  return /color$/i.test(key);
}

/** Guard against a hand-crafted spec nesting deeply enough to blow the stack. */
const MAX_DEPTH = 16;

const DROP = Symbol('drop');

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeString(value: string, key: string): string | typeof DROP {
  if (FUNCTION_SHAPED.test(value)) return DROP;
  if (isHtmlSinkKey(key) && value.includes('<')) return DROP;
  if (isCssSinkKey(key) && (value.includes(';') || value.includes('<'))) return DROP;
  return value;
}

/**
 * `key` is the nearest enclosing property name — array elements inherit their
 * array's key so `color: ["#fff", "red;…"]` is judged as colours.
 */
function sanitizeValue(value: unknown, depth: number, key: string): unknown | typeof DROP {
  if (depth > MAX_DEPTH) return DROP;
  if (value === null) return null;
  switch (typeof value) {
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : DROP;
    case 'string':
      return sanitizeString(value, key);
    case 'object':
      break;
    default:
      // functions, symbols, undefined, bigint — not data.
      return DROP;
  }
  if (Array.isArray(value)) {
    // Position is meaning: `xAxis.data[2]` pairs with `series[0].data[2]`.
    // A dropped element becomes `null`, never a hole that shifts the rest.
    return value.map((item) => {
      const kept = sanitizeValue(item, depth + 1, key);
      return kept === DROP ? null : kept;
    });
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const childKey of Object.keys(source)) {
    if (UNSAFE_KEYS.has(childKey) || DENIED_KEYS.has(childKey)) continue;
    const kept = sanitizeValue(source[childKey], depth + 1, childKey);
    if (kept !== DROP) out[childKey] = kept;
  }
  return out;
}

function sanitizeSeries(value: unknown): Record<string, unknown>[] {
  const entries = Array.isArray(value) ? value : [value];
  const out: Record<string, unknown>[] = [];
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue;
    if (typeof entry.type !== 'string' || !SERIES_TYPES.has(entry.type)) continue;
    const kept = sanitizeValue(entry, 1, 'series');
    if (isPlainObject(kept)) out.push(kept);
  }
  return out;
}

/**
 * Reduce an arbitrary parsed value to the spec-1 subset.
 *
 * Returns `null` when nothing renderable survives — a non-object root, or an
 * option with no series of an allowed type. Callers treat `null` as "show the
 * code block".
 */
export function sanitizeChartOption(raw: unknown): Record<string, unknown> | null {
  if (!isPlainObject(raw)) return null;
  const series = sanitizeSeries(raw.series);
  if (series.length === 0) return null;

  const option: Record<string, unknown> = { series };
  for (const key of Object.keys(raw)) {
    if (key === 'series' || !TOP_LEVEL.has(key)) continue;
    const kept = sanitizeValue(raw[key], 1, key);
    if (kept !== DROP) option[key] = kept;
  }
  return option;
}

/**
 * Fence body → renderable option. Invalid JSON and specs that do not survive
 * the filter both yield `null`, which is the code-block fallback.
 */
export function parseChartFence(source: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  return sanitizeChartOption(parsed);
}
