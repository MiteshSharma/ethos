import { describe, expect, it } from 'vitest';
import { hasFlag, parseFlagValue, parsePort } from '../serve-helpers';

describe('parseFlagValue', () => {
  it('handles --name=value', () => {
    expect(parseFlagValue(['--port=4000'], ['--port'])).toBe('4000');
  });

  it('handles --name value', () => {
    expect(parseFlagValue(['--port', '4000'], ['--port'])).toBe('4000');
  });

  it('returns empty string when flag is set without a value', () => {
    expect(parseFlagValue(['--port'], ['--port'])).toBe('');
  });

  it('returns undefined when flag is absent', () => {
    expect(parseFlagValue(['serve', '--web-experimental'], ['--port'])).toBeUndefined();
  });

  it('matches the first alias hit', () => {
    expect(parseFlagValue(['--p=1', '--port=2'], ['--port', '--p'])).toBe('1');
  });
});

describe('hasFlag', () => {
  it('detects a bare flag', () => {
    expect(hasFlag(['serve', '--web-experimental'], ['--web-experimental'])).toBe(true);
  });

  it('detects --name=value form', () => {
    expect(hasFlag(['--web-experimental=true'], ['--web-experimental'])).toBe(true);
  });

  it('does not match similar prefixes', () => {
    // `--web-port` should not satisfy a check for `--web` (would be a footgun
    // since users expect `--web` to be exact).
    expect(hasFlag(['--web-port=3000'], ['--web'])).toBe(false);
  });

  it('returns false when no flag matches', () => {
    expect(hasFlag(['serve'], ['--web-experimental'])).toBe(false);
  });
});

describe('parsePort', () => {
  it.each([
    ['3000', 3000],
    ['65535', 65535],
    ['1', 1],
  ])('accepts %s', (raw, expected) => {
    expect(parsePort(raw, 9999)).toBe(expected);
  });

  it.each([
    ['', 9999],
    ['nope', 9999],
    ['0', 9999],
    ['-1', 9999],
    ['65536', 9999],
    ['3.14', 9999],
  ])('falls back on invalid input %s', (raw, fallback) => {
    expect(parsePort(raw, fallback)).toBe(fallback);
  });

  it('falls back when undefined', () => {
    expect(parsePort(undefined, 3000)).toBe(3000);
  });
});
