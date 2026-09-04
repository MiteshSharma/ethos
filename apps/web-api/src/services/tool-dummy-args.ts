// Dummy-argument generation + validation for the JSON-schema subset Ethos
// tools actually declare (object at the root; string / number / integer /
// boolean / array / object / enum below it).
//
// Deliberately NOT a JSON-schema library. `tools.test` needs exactly two
// things — a plausible argument object to hand a read-only tool, and a check
// that the object it generated matches the schema it came from — and a full
// validator (refs, allOf, formats, conditionals) would be several hundred
// lines answering questions no tool in this repo asks.

/** One JSON-schema node, as far as this module understands schemas. */
type SchemaNode = Record<string, unknown>;

function isRecord(value: unknown): value is SchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `type` may be a string or an array of strings; the first entry wins. */
function typeOf(node: SchemaNode): string | undefined {
  const t = node.type;
  if (typeof t === 'string') return t;
  if (Array.isArray(t) && typeof t[0] === 'string') return t[0];
  return undefined;
}

function requiredKeys(node: SchemaNode): string[] {
  const req = node.required;
  return Array.isArray(req) ? req.filter((k): k is string => typeof k === 'string') : [];
}

function properties(node: SchemaNode): SchemaNode {
  return isRecord(node.properties) ? node.properties : {};
}

/**
 * A representative value for one schema node.
 *
 * Precedence: `default`, then `example`, then `enum`'s first member, then the
 * declared `type`. A node with no type and no properties falls back to a
 * string — every such node in the repo is a loosely-declared text field.
 */
function valueFor(node: SchemaNode): unknown {
  if ('default' in node) return node.default;
  if ('example' in node) return node.example;
  if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];

  switch (typeOf(node)) {
    case 'string':
      return 'example';
    case 'number':
    case 'integer':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object':
      return objectFor(node);
    case 'null':
      return null;
    default:
      return isRecord(node.properties) ? objectFor(node) : 'example';
  }
}

/** Only REQUIRED properties are populated — an optional argument the caller
 *  did not ask for is noise the tool has to defend against. */
function objectFor(node: SchemaNode): Record<string, unknown> {
  const props = properties(node);
  const out: Record<string, unknown> = {};
  for (const key of requiredKeys(node)) {
    const child = props[key];
    out[key] = isRecord(child) ? valueFor(child) : 'example';
  }
  return out;
}

/**
 * Generate a dummy argument object for a tool's `schema`. Always an object —
 * every tool in Ethos takes a named-argument record — so a schema that is
 * absent, malformed, or declares no required properties yields `{}`.
 */
export function generateDummyArgs(schema: unknown): Record<string, unknown> {
  return isRecord(schema) ? objectFor(schema) : {};
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    case 'null':
      return value === null;
    default:
      // An unknown `type` keyword is not something to fail a tool over.
      return true;
  }
}

function typeMatches(node: SchemaNode, value: unknown): boolean {
  const t = node.type;
  if (typeof t === 'string') return matchesType(t, value);
  if (Array.isArray(t)) {
    const names = t.filter((n): n is string => typeof n === 'string');
    return names.length === 0 || names.some((n) => matchesType(n, value));
  }
  return true;
}

function collect(node: SchemaNode, value: unknown, path: string, errors: string[]): void {
  if (!typeMatches(node, value)) {
    errors.push(`${path}: expected ${JSON.stringify(node.type)}, got ${typeof value}`);
    return;
  }

  if (Array.isArray(node.enum) && node.enum.length > 0 && !node.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(node.enum)}`);
    return;
  }

  if (isRecord(value)) {
    const props = properties(node);
    for (const key of requiredKeys(node)) {
      if (!(key in value)) {
        errors.push(`${path}.${key}: required property missing`);
        continue;
      }
      const child = props[key];
      if (isRecord(child)) collect(child, value[key], `${path}.${key}`, errors);
    }
    return;
  }

  if (Array.isArray(value) && isRecord(node.items)) {
    const items = node.items;
    value.forEach((entry, i) => {
      collect(items, entry, `${path}[${i}]`, errors);
    });
  }
}

/**
 * Validate a value against the schema subset above. Returns one message per
 * problem, empty when the value conforms. A non-object schema validates
 * anything — there is nothing to check against.
 */
export function validateAgainstSchema(schema: unknown, value: unknown): string[] {
  if (!isRecord(schema)) return [];
  const errors: string[] = [];
  collect(schema, value, 'args', errors);
  return errors;
}
