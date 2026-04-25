import { describe, expect, it } from 'vitest';
import {
  isEthosPlugin,
  normalizeExternalPluginCompatibility,
  validatePluginPackageJson,
} from '../index';

describe('validatePluginPackageJson', () => {
  const valid = {
    name: 'ethos-plugin-foo',
    version: '1.0.0',
    description: 'A test plugin',
    main: 'index.js',
    ethos: { type: 'plugin' },
  };

  it('accepts a valid plugin package.json', () => {
    const result = validatePluginPackageJson(valid);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects non-object input', () => {
    expect(validatePluginPackageJson(null).valid).toBe(false);
    expect(validatePluginPackageJson('string').valid).toBe(false);
  });

  it('requires name field', () => {
    const result = validatePluginPackageJson({ ...valid, name: undefined });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('name'))).toBe(true);
  });

  it('requires version field', () => {
    const result = validatePluginPackageJson({ ...valid, version: undefined });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('version'))).toBe(true);
  });

  it('requires ethos.type = "plugin"', () => {
    const result = validatePluginPackageJson({ ...valid, ethos: { type: 'other' } });
    expect(result.valid).toBe(false);
  });

  it('warns when description is missing', () => {
    const result = validatePluginPackageJson({ ...valid, description: undefined });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes('description'))).toBe(true);
  });

  it('warns when no entry point declared', () => {
    const result = validatePluginPackageJson({ ...valid, main: undefined, exports: undefined });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes('main') || w.includes('exports'))).toBe(true);
  });
});

describe('isEthosPlugin', () => {
  it('returns true for valid plugin package.json', () => {
    expect(isEthosPlugin({ name: 'foo', ethos: { type: 'plugin' } })).toBe(true);
  });

  it('returns false when ethos.type is missing or wrong', () => {
    expect(isEthosPlugin({ name: 'foo' })).toBe(false);
    expect(isEthosPlugin({ name: 'foo', ethos: { type: 'other' } })).toBe(false);
  });

  it('returns false for non-objects', () => {
    expect(isEthosPlugin(null)).toBe(false);
    expect(isEthosPlugin('string')).toBe(false);
  });
});

describe('normalizeExternalPluginCompatibility', () => {
  it('returns compatible when no pluginApi constraint', () => {
    const result = normalizeExternalPluginCompatibility(undefined, '1.0.0');
    expect(result.compatible).toBe(true);
  });

  it('returns compatible when major versions match', () => {
    const result = normalizeExternalPluginCompatibility('1.2.0', '1.5.0');
    expect(result.compatible).toBe(true);
  });

  it('returns incompatible when major versions differ', () => {
    const result = normalizeExternalPluginCompatibility('2.0.0', '1.5.0');
    expect(result.compatible).toBe(false);
    expect(result.reason).toBeDefined();
  });
});
