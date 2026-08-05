// Lane 4a — unit coverage for the stage-2 coercion rules and the stage-3
// per-field message. Loop-level behavior (repaired path only, rejection
// routing) is covered in malformed-tool-args.test.ts; this file pins the
// conservative edges of the coercion itself.

import { describe, expect, it } from 'vitest';
import { coerceArgsToSchema, describeRepairedArgsFailure } from '../schema-coerce';

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
});

describe('coerceArgsToSchema', () => {
  it('coerces numeric strings, including floats and negatives', () => {
    const s = schema({ a: { type: 'number' }, b: { type: 'number' } });
    expect(coerceArgsToSchema(s, { a: ' 5 ', b: '-2.5' })).toEqual({
      args: { a: 5, b: -2.5 },
      mismatches: [],
    });
  });

  it('integer fields reject non-integral numeric strings', () => {
    const s = schema({ n: { type: 'integer' } });
    expect(coerceArgsToSchema(s, { n: '2.5' }).mismatches).toEqual([
      { field: 'n', expected: 'integer', got: 'string' },
    ]);
    expect(coerceArgsToSchema(s, { n: '3' }).args).toEqual({ n: 3 });
  });

  it('empty and non-numeric strings are mismatches, not zero', () => {
    const s = schema({ n: { type: 'number' } });
    expect(coerceArgsToSchema(s, { n: '' }).mismatches).toHaveLength(1);
    expect(coerceArgsToSchema(s, { n: 'lots' }).mismatches).toHaveLength(1);
  });

  it('booleans accept case-insensitive "true"/"false" and nothing else', () => {
    const s = schema({ f: { type: 'boolean' } });
    expect(coerceArgsToSchema(s, { f: 'True' }).args).toEqual({ f: true });
    expect(coerceArgsToSchema(s, { f: 'FALSE' }).args).toEqual({ f: false });
    expect(coerceArgsToSchema(s, { f: 'yes' }).mismatches).toEqual([
      { field: 'f', expected: 'boolean', got: 'string' },
    ]);
    // Truthiness is never used: 1 for boolean is a mismatch, not `true`.
    expect(coerceArgsToSchema(s, { f: 1 }).mismatches).toHaveLength(1);
  });

  it('wraps a scalar into an array only when it matches the declared item type', () => {
    const strings = schema({ xs: { type: 'array', items: { type: 'string' } } });
    expect(coerceArgsToSchema(strings, { xs: 'one' }).args).toEqual({ xs: ['one'] });
    // Item type mismatch → no wrap, reported as a mismatch on the array field.
    expect(coerceArgsToSchema(strings, { xs: 42 }).mismatches).toEqual([
      { field: 'xs', expected: 'array', got: 'number' },
    ]);
    // No declared item type → wrap whatever the value is.
    const anyItems = schema({ xs: { type: 'array' } });
    expect(coerceArgsToSchema(anyItems, { xs: 42 }).args).toEqual({ xs: [42] });
  });

  it('leaves matching values, undeclared fields, and union types untouched', () => {
    const s = schema({
      n: { type: 'number' },
      u: { type: ['string', 'null'] },
    });
    const args = { n: 5, u: 42, extra: 'anything' };
    const result = coerceArgsToSchema(s, args);
    expect(result.args).toEqual(args);
    expect(result.mismatches).toEqual([]);
  });

  it('passes non-object args through untouched', () => {
    const s = schema({ n: { type: 'number' } });
    expect(coerceArgsToSchema(s, [1, 2])).toEqual({ args: [1, 2], mismatches: [] });
    expect(coerceArgsToSchema(s, null)).toEqual({ args: null, mismatches: [] });
  });
});

describe('describeRepairedArgsFailure', () => {
  it('names missing fields with their declared type and mismatches with expected/got', () => {
    const s = schema({ path: { type: 'string' }, count: { type: 'number' } }, ['path', 'count']);
    const message = describeRepairedArgsFailure(
      s,
      ['path'],
      [{ field: 'count', expected: 'number', got: 'string' }],
    );
    expect(message).toContain('missing required field(s): path (expected string)');
    expect(message).toContain('wrong-typed field(s): count (expected number, got string)');
  });

  it('omits the type annotation when the schema declares none', () => {
    const s = schema({}, ['content']);
    expect(describeRepairedArgsFailure(s, ['content'], [])).toContain(
      'missing required field(s): content',
    );
    expect(describeRepairedArgsFailure(s, ['content'], [])).not.toContain('expected');
  });
});
