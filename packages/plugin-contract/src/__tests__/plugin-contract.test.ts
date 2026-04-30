import { describe, expect, it } from 'vitest';
import {
  checkPluginContractMajor,
  isEthosPlugin,
  normalizeExternalPluginCompatibility,
  PLUGIN_CONTRACT_MAJOR,
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

describe('checkPluginContractMajor', () => {
  it('returns ok when declared major matches current', () => {
    const result = checkPluginContractMajor(PLUGIN_CONTRACT_MAJOR);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('returns ok when declared is undefined (older plugin without declaration)', () => {
    const result = checkPluginContractMajor(undefined);
    expect(result.ok).toBe(true);
  });

  it('rejects when declared major differs from current', () => {
    const result = checkPluginContractMajor(999, PLUGIN_CONTRACT_MAJOR, 'ethos-plugin-future');
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toMatch(/ethos-plugin-future/);
    expect(result.reason).toMatch(/pluginContractMajor=999/);
    expect(result.reason).toMatch(/MIGRATIONS\.md/);
  });

  it('rejects a non-integer declared major', () => {
    const result = checkPluginContractMajor(-1, PLUGIN_CONTRACT_MAJOR, 'bad-plugin');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/bad-plugin/);
    expect(result.reason).toMatch(/MIGRATIONS\.md/);
  });

  it('uses PLUGIN_CONTRACT_MAJOR as default current', () => {
    // Explicit current=PLUGIN_CONTRACT_MAJOR should behave the same as omitting it
    const a = checkPluginContractMajor(PLUGIN_CONTRACT_MAJOR, PLUGIN_CONTRACT_MAJOR);
    const b = checkPluginContractMajor(PLUGIN_CONTRACT_MAJOR);
    expect(a.ok).toBe(b.ok);
  });

  it('error message includes both declared and current major', () => {
    const result = checkPluginContractMajor(2, 1, 'my-plugin');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/major=1/);
    expect(result.reason).toMatch(/pluginContractMajor=2/);
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
