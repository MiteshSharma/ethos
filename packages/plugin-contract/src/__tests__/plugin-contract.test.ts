import { describe, expect, it } from 'vitest';
import type { CredentialDeclaration } from '../index';
import {
  checkPluginContractMajor,
  isEthosPlugin,
  MIN_SUPPORTED_PLUGIN_CONTRACT_MAJOR,
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

  it('exports a minimum supported major below the current major', () => {
    expect(MIN_SUPPORTED_PLUGIN_CONTRACT_MAJOR).toBe(2);
    expect(MIN_SUPPORTED_PLUGIN_CONTRACT_MAJOR).toBeLessThanOrEqual(PLUGIN_CONTRACT_MAJOR);
  });

  // Item 7 stage 2 — adding the OPTIONAL `ContextEngine.onTurnComplete` method
  // must not move the contract major. Per version.ts the only bump triggers are
  // a field rename, a field removal, and a REQUIRED-field addition; an additive
  // optional method stays on the same major. This pins that argument: if the
  // method is ever made required, this assertion is the first thing to fail.
  it('stays on major 4 across additive optional contract methods', () => {
    expect(PLUGIN_CONTRACT_MAJOR).toBe(4);
  });

  it('accepts an in-range older major (major-3 plugin on a major-4 build)', () => {
    const result = checkPluginContractMajor(3, 4, 'old-plugin');
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('accepts a plugin declaring the current major', () => {
    const result = checkPluginContractMajor(4, 4);
    expect(result.ok).toBe(true);
  });

  it('rejects a plugin below the minimum supported major', () => {
    const result = checkPluginContractMajor(1, 4, 'too-old');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/MIGRATIONS\.md/);
    expect(result.reason).toMatch(/minimum/i);
    expect(result.reason).toMatch(/2/);
  });

  it('rejects a plugin built for a future major', () => {
    const result = checkPluginContractMajor(5, 4, 'too-new');
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
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

describe('credentials validation', () => {
  const base = {
    name: 'ethos-plugin-creds',
    version: '1.0.0',
    description: 'Plugin with credentials',
    main: 'index.js',
    ethos: { type: 'plugin' as const },
  };

  const validCred: CredentialDeclaration = {
    key: 'API_KEY',
    label: 'API Key',
    type: 'secret',
    description: 'The API key for the service',
    refreshHint: 'weekly',
    required: true,
  };

  it('accepts valid credentials array', () => {
    const result = validatePluginPackageJson({
      ...base,
      ethos: { ...base.ethos, credentials: [validCred] },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects credential with invalid key', () => {
    const result = validatePluginPackageJson({
      ...base,
      ethos: {
        ...base.ethos,
        credentials: [{ ...validCred, key: 'bad key!' }],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('credentials[0].key'))).toBe(true);
  });

  it('rejects credential with missing label', () => {
    const result = validatePluginPackageJson({
      ...base,
      ethos: {
        ...base.ethos,
        credentials: [{ ...validCred, label: '' }],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('credentials[0].label'))).toBe(true);
  });

  it('rejects credential with invalid type', () => {
    const result = validatePluginPackageJson({
      ...base,
      ethos: {
        ...base.ethos,
        credentials: [{ ...validCred, type: 'password' }],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('credentials[0].type'))).toBe(true);
  });

  it('accepts package.json without credentials (backwards compat)', () => {
    const result = validatePluginPackageJson(base);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
