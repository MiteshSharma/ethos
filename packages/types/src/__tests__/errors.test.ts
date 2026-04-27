import { describe, expect, it } from 'vitest';
import { EthosError, formatError, isEthosError, toEthosError } from '../errors';

describe('EthosError', () => {
  it('extends Error and exposes structured fields', () => {
    const err = new EthosError({
      code: 'INVALID_INPUT',
      cause: 'foo missing',
      action: 'pass --foo',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EthosError');
    expect(err.message).toBe('foo missing');
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.cause).toBe('foo missing');
    expect(err.action).toBe('pass --foo');
  });

  it('isEthosError narrows', () => {
    const err: unknown = new EthosError({ code: 'INTERNAL', cause: 'x', action: 'y' });
    expect(isEthosError(err)).toBe(true);
    expect(isEthosError(new Error('boom'))).toBe(false);
    expect(isEthosError('string')).toBe(false);
    expect(isEthosError(null)).toBe(false);
  });

  it('toEthosError passes through EthosError instances', () => {
    const original = new EthosError({
      code: 'CONFIG_MISSING',
      cause: 'no config',
      action: 'setup',
    });
    expect(toEthosError(original)).toBe(original);
  });

  it('toEthosError wraps plain Error with INTERNAL by default', () => {
    const wrapped = toEthosError(new Error('boom'));
    expect(wrapped).toBeInstanceOf(EthosError);
    expect(wrapped.code).toBe('INTERNAL');
    expect(wrapped.cause).toBe('boom');
  });

  it('toEthosError respects fallbackCode', () => {
    const wrapped = toEthosError(new Error('net down'), 'NETWORK_ERROR');
    expect(wrapped.code).toBe('NETWORK_ERROR');
  });

  it('toEthosError handles non-Error throwables', () => {
    const wrapped = toEthosError('plain string');
    expect(wrapped.code).toBe('INTERNAL');
    expect(wrapped.cause).toBe('plain string');
  });

  it('formatError renders code, cause, and action', () => {
    const err = new EthosError({
      code: 'INVALID_INPUT',
      cause: '--foo missing',
      action: 'pass --foo',
    });
    const out = formatError(err);
    expect(out).toContain('INVALID_INPUT');
    expect(out).toContain('--foo missing');
    expect(out).toContain('pass --foo');
    // Default: no ANSI escapes
    expect(out).not.toContain('\x1b[');
  });

  it('formatError emits ANSI when color: true', () => {
    const err = new EthosError({ code: 'INTERNAL', cause: 'x', action: 'y' });
    const out = formatError(err, { color: true });
    expect(out).toContain('\x1b[');
  });
});
