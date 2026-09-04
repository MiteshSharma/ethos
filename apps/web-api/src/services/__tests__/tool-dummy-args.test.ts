import { describe, expect, it } from 'vitest';
import { generateDummyArgs, validateAgainstSchema } from '../tool-dummy-args';

describe('generateDummyArgs', () => {
  it('populates only required properties, by declared type', () => {
    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string' },
        limit: { type: 'integer' },
        ratio: { type: 'number' },
        recursive: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
        optional: { type: 'string' },
      },
      required: ['path', 'limit', 'ratio', 'recursive', 'tags'],
    };

    expect(generateDummyArgs(schema)).toEqual({
      path: 'example',
      limit: 1,
      ratio: 1,
      recursive: true,
      tags: [],
    });
  });

  it('prefers default, then example, then the first enum member', () => {
    const schema = {
      type: 'object',
      properties: {
        a: { type: 'string', default: 'from-default', example: 'from-example' },
        b: { type: 'string', example: 'from-example' },
        c: { type: 'string', enum: ['first', 'second'] },
      },
      required: ['a', 'b', 'c'],
    };

    expect(generateDummyArgs(schema)).toEqual({
      a: 'from-default',
      b: 'from-example',
      c: 'first',
    });
  });

  it('recurses into nested objects, required properties only', () => {
    const schema = {
      type: 'object',
      properties: {
        query: {
          type: 'object',
          properties: { text: { type: 'string' }, page: { type: 'integer' } },
          required: ['text'],
        },
      },
      required: ['query'],
    };

    expect(generateDummyArgs(schema)).toEqual({ query: { text: 'example' } });
  });

  it('uses the first entry of a union type', () => {
    const schema = {
      type: 'object',
      properties: { value: { type: ['integer', 'string'] } },
      required: ['value'],
    };

    expect(generateDummyArgs(schema)).toEqual({ value: 1 });
  });

  it('returns an empty object for a schema with no required properties', () => {
    expect(generateDummyArgs({ type: 'object', properties: { a: { type: 'string' } } })).toEqual(
      {},
    );
    expect(generateDummyArgs(undefined)).toEqual({});
    expect(generateDummyArgs('not a schema')).toEqual({});
  });

  it('generates values that validate against the schema they came from', () => {
    const schema = {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['read', 'write'] },
        nested: {
          type: 'object',
          properties: { count: { type: 'integer' } },
          required: ['count'],
        },
      },
      required: ['mode', 'nested'],
    };

    expect(validateAgainstSchema(schema, generateDummyArgs(schema))).toEqual([]);
  });
});

describe('validateAgainstSchema', () => {
  it('reports a missing required property', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    expect(validateAgainstSchema(schema, {})).toEqual(['args.a: required property missing']);
  });

  it('reports a type mismatch on a nested property', () => {
    const schema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] };
    const errors = validateAgainstSchema(schema, { n: 'nope' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('args.n');
  });

  it('reports a value outside an enum', () => {
    const schema = { type: 'object', properties: { m: { enum: ['a', 'b'] } }, required: ['m'] };
    const errors = validateAgainstSchema(schema, { m: 'c' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('args.m');
  });

  it('validates array items', () => {
    const schema = {
      type: 'object',
      properties: { list: { type: 'array', items: { type: 'string' } } },
      required: ['list'],
    };
    expect(validateAgainstSchema(schema, { list: ['ok'] })).toEqual([]);
    expect(validateAgainstSchema(schema, { list: [1] })).toHaveLength(1);
  });

  it('accepts an integer for a number but not a fraction for an integer', () => {
    const numeric = { type: 'object', properties: { v: { type: 'number' } }, required: ['v'] };
    const integral = { type: 'object', properties: { v: { type: 'integer' } }, required: ['v'] };
    expect(validateAgainstSchema(numeric, { v: 1.5 })).toEqual([]);
    expect(validateAgainstSchema(integral, { v: 1.5 })).toHaveLength(1);
  });

  it('validates nothing when the schema is not an object', () => {
    expect(validateAgainstSchema(undefined, { anything: true })).toEqual([]);
  });
});
