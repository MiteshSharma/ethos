// ---------------------------------------------------------------------------
// Lane 3(a) — tool-schema sanitizer for llamacpp-class local dialects.
//
// On llama.cpp-derived runtimes (llama.cpp server, Ollama, LM Studio) tool
// schemas are compiled to GBNF grammars, and ONE bad schema breaks tool
// calling for the entire deployment — the tool payload ships on every
// request, not just requests that would use the offending tool. Known
// breakers (plan lane 3) and their transformations here:
//
//   | Breaker                        | Transformation                        |
//   |--------------------------------|---------------------------------------|
//   | Unanchored `pattern`           | wrap in `^(?:…)$`; drop if unanchorable |
//   | PCRE shorthand (\S \d \w …)    | rewrite to character classes; drop the |
//   |                                | constraint when unrewritable          |
//   | `maxLength` above ~2000        | clamp to 2000 (grammar expansion)     |
//   | `anyOf` multi-type unions      | flatten to the permissive branch      |
//
// Placement (eng review D7): the sanitizer lives at the openai-compat
// provider boundary — only the provider knows the dialect — and
// `tools-mcp` stays dialect-blind. Anthropic and hosted OpenAI-compat
// dialects accept these schemas fine; they pass through UNTOUCHED.
//
// First-party Ethos schemas are clean (verified in the plan: no JSON-Schema
// `pattern`/`maxLength` constraint keywords in extensions/tools-*) — the
// exposure is MCP-borne — but the sanitizer runs on whatever reaches this
// boundary.
//
// Deep-clone discipline follows extensions/tools-mcp/src/schema-rewrite.ts:
// clone once, rewrite the clone in place, never mutate the input.
//
// Every transformation is REPORTED (a `changes` line naming the tool and the
// change) so the caller can log it — a silent drop is a test failure (plan
// acceptance criterion, promoted from the risk list by the eng review).
// ---------------------------------------------------------------------------

/** `maxLength` clamp — above roughly this, GBNF grammar expansion blows up. */
export const GRAMMAR_MAX_LENGTH_CLAMP = 2000;

export interface SanitizedToolSchema {
  schema: Record<string, unknown>;
  /** One human-readable line per transformation, naming the tool + change.
   *  Empty when the schema needed no sanitizing. */
  changes: string[];
}

// PCRE shorthand → GBNF-safe character classes. `inside` is the replacement
// within a character class; `null` there means the shorthand cannot be
// expressed inside a class (negated forms) → drop the constraint.
const SHORTHAND: Record<string, { outside: string; inside: string | null }> = {
  d: { outside: '[0-9]', inside: '0-9' },
  D: { outside: '[^0-9]', inside: null },
  w: { outside: '[a-zA-Z0-9_]', inside: 'a-zA-Z0-9_' },
  W: { outside: '[^a-zA-Z0-9_]', inside: null },
  s: { outside: '[ \\t\\n]', inside: ' \\t\\n' },
  S: { outside: '[^ \\t\\n]', inside: null },
};

/** Constructs with no GBNF lowering at all — the constraint is dropped. */
const UNSUPPORTED_CONSTRUCTS = /\(\?[=!<]|\\[1-9]|\\[bB]/;

/** Rewrite PCRE shorthand to character classes, class-position aware.
 *  Returns null when the pattern uses shorthand in a position that cannot be
 *  rewritten (negated shorthand inside a character class). */
function rewriteShorthand(pattern: string): { value: string; changed: boolean } | null {
  let out = '';
  let changed = false;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      const next = pattern[i + 1] ?? '';
      const rep = SHORTHAND[next];
      if (rep) {
        const sub = inClass ? rep.inside : rep.outside;
        if (sub === null) return null;
        out += sub;
        changed = true;
      } else {
        out += ch + next;
      }
      i++;
      continue;
    }
    if (ch === '[' && !inClass) inClass = true;
    else if (ch === ']' && inClass) inClass = false;
    out += ch;
  }
  return { value: out, changed };
}

/** True when `p[i]` is preceded by an odd number of backslashes (escaped). */
function isEscapedAt(p: string, i: number): boolean {
  let backslashes = 0;
  for (let j = i - 1; j >= 0 && p[j] === '\\'; j--) backslashes++;
  return backslashes % 2 === 1;
}

/** Any unescaped `^`/`$` anchor OUTSIDE a character class (where `^` is
 *  negation, not an anchor). */
function hasUnescapedAnchor(p: string): boolean {
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (isEscapedAt(p, i)) continue;
    if (ch === '[' && !inClass) inClass = true;
    else if (ch === ']' && inClass) inClass = false;
    else if ((ch === '^' || ch === '$') && !inClass) return true;
  }
  return false;
}

/** Fully anchored: starts with `^` and ends with an unescaped `$`. */
function isFullyAnchored(p: string): boolean {
  return p.startsWith('^') && p.endsWith('$') && !isEscapedAt(p, p.length - 1);
}

// Keys whose values are records of schemas.
const SCHEMA_MAP_KEYS = ['properties', 'patternProperties', '$defs', 'definitions'];
// Keys whose values are a single schema.
const SCHEMA_KEYS = [
  'items',
  'additionalItems',
  'additionalProperties',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
];
// Keys whose values are arrays of schemas.
const SCHEMA_LIST_KEYS = ['anyOf', 'allOf', 'oneOf', 'prefixItems', 'items'];
// NOTE: `enum`, `const`, `default`, and `examples` hold DATA, not schemas —
// the walk deliberately never descends into them, so a default value like
// `{ pattern: "abc" }` is never mistaken for a constraint.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Most permissive first — a string can encode any value, so under a grammar
 *  it is the branch that loses the least. */
const TYPE_PERMISSIVENESS = ['string', 'object', 'array', 'number', 'integer', 'boolean', 'null'];

function flattenAnyOf(
  node: Record<string, unknown>,
  toolName: string,
  path: string,
  changes: string[],
): void {
  const anyOf = node.anyOf;
  if (!Array.isArray(anyOf) || anyOf.length < 2) return;
  const branches = anyOf.filter(isRecord);
  if (branches.length !== anyOf.length) return;
  const types = branches.map((b) => b.type);
  if (!types.every((t): t is string => typeof t === 'string')) return;
  if (new Set(types).size < 2) return; // single-type union — no GBNF problem

  let chosen = branches[0];
  let chosenRank = TYPE_PERMISSIVENESS.indexOf(types[0] ?? '');
  if (chosenRank === -1) chosenRank = TYPE_PERMISSIVENESS.length;
  for (let i = 1; i < branches.length; i++) {
    let rank = TYPE_PERMISSIVENESS.indexOf(types[i] ?? '');
    if (rank === -1) rank = TYPE_PERMISSIVENESS.length;
    if (rank < chosenRank) {
      chosen = branches[i];
      chosenRank = rank;
    }
  }
  if (!chosen) return;

  delete node.anyOf;
  for (const [k, v] of Object.entries(chosen)) {
    if (!(k in node)) node[k] = v;
  }
  changes.push(
    `${toolName}: flattened anyOf multi-type union (${types.join('|')}) at ${path || 'root'} ` +
      `to the permissive '${chosen.type}' branch`,
  );
}

function sanitizePattern(
  node: Record<string, unknown>,
  toolName: string,
  path: string,
  changes: string[],
): void {
  const pattern = node.pattern;
  if (typeof pattern !== 'string') return;
  const at = path ? `${path}.pattern` : 'pattern';

  if (UNSUPPORTED_CONSTRUCTS.test(pattern)) {
    delete node.pattern;
    changes.push(
      `${toolName}: dropped pattern at ${at} ('${pattern}') — ` +
        `uses constructs with no GBNF lowering (lookaround/backreference/word boundary)`,
    );
    return;
  }

  const rewritten = rewriteShorthand(pattern);
  if (rewritten === null) {
    delete node.pattern;
    changes.push(
      `${toolName}: dropped pattern at ${at} ('${pattern}') — ` +
        `negated PCRE shorthand inside a character class cannot be rewritten for GBNF`,
    );
    return;
  }
  const value = rewritten.value;
  if (rewritten.changed) {
    changes.push(
      `${toolName}: rewrote PCRE shorthand in pattern at ${at} ('${pattern}' → '${value}')`,
    );
  }

  if (isFullyAnchored(value)) {
    node.pattern = value;
    return;
  }
  if (hasUnescapedAnchor(value)) {
    // Partial or interior anchoring — wrapping would change the meaning.
    delete node.pattern;
    changes.push(
      `${toolName}: dropped pattern at ${at} ('${pattern}') — ` +
        `partially anchored, cannot be safely wrapped in ^(?:…)$ for GBNF`,
    );
    return;
  }
  const anchored = `^(?:${value})$`;
  changes.push(`${toolName}: anchored unanchored pattern at ${at} ('${value}' → '${anchored}')`);
  node.pattern = anchored;
}

function sanitizeNode(
  node: Record<string, unknown>,
  toolName: string,
  path: string,
  changes: string[],
): void {
  // Flatten first so constraints on the surviving branch get sanitized below.
  flattenAnyOf(node, toolName, path, changes);
  sanitizePattern(node, toolName, path, changes);

  const maxLength = node.maxLength;
  if (typeof maxLength === 'number' && maxLength > GRAMMAR_MAX_LENGTH_CLAMP) {
    node.maxLength = GRAMMAR_MAX_LENGTH_CLAMP;
    changes.push(
      `${toolName}: clamped maxLength ${maxLength} → ${GRAMMAR_MAX_LENGTH_CLAMP} at ` +
        `${path ? `${path}.maxLength` : 'maxLength'} (GBNF grammar expansion)`,
    );
  }

  for (const key of SCHEMA_MAP_KEYS) {
    const map = node[key];
    if (!isRecord(map)) continue;
    for (const [name, sub] of Object.entries(map)) {
      if (isRecord(sub))
        sanitizeNode(sub, toolName, path ? `${path}.${key}.${name}` : `${key}.${name}`, changes);
    }
  }
  for (const key of SCHEMA_KEYS) {
    const sub = node[key];
    if (isRecord(sub)) sanitizeNode(sub, toolName, path ? `${path}.${key}` : key, changes);
  }
  for (const key of SCHEMA_LIST_KEYS) {
    const list = node[key];
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i++) {
      const sub = list[i];
      if (isRecord(sub))
        sanitizeNode(sub, toolName, path ? `${path}.${key}[${i}]` : `${key}[${i}]`, changes);
    }
  }
}

/**
 * Sanitize one tool's JSON-Schema parameters for a llamacpp-class grammar
 * compiler. Pure: deep-clones the input (schema-rewrite.ts discipline) and
 * returns the sanitized clone plus one change line per transformation.
 */
export function sanitizeToolSchemaForGrammar(
  toolName: string,
  schema: Record<string, unknown>,
): SanitizedToolSchema {
  const clone = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  const changes: string[] = [];
  sanitizeNode(clone, toolName, '', changes);
  return { schema: clone, changes };
}
