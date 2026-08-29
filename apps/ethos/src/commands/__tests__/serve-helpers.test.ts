import type { EthosConfig } from '@ethosagent/config';
import { describe, expect, it } from 'vitest';
import {
  a2aZeroSkillsWarning,
  hasFlag,
  parseFlagValue,
  parsePort,
  resolveCorsOrigins,
  resolveWebHost,
  resolveWebPort,
  WEB_PORT_DEFAULT,
} from '../serve-helpers';

const BASE = {
  provider: 'anthropic',
  model: 'm',
  apiKey: 'sk',
  personality: 'p',
} satisfies EthosConfig;

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
    expect(parseFlagValue(['serve', '--verbose'], ['--port'])).toBeUndefined();
  });

  it('matches the first alias hit', () => {
    expect(parseFlagValue(['--p=1', '--port=2'], ['--port', '--p'])).toBe('1');
  });
});

describe('hasFlag', () => {
  it('detects a bare flag', () => {
    expect(hasFlag(['serve', '--verbose'], ['--verbose'])).toBe(true);
  });

  it('detects --name=value form', () => {
    expect(hasFlag(['--verbose=true'], ['--verbose'])).toBe(true);
  });

  it('does not match similar prefixes', () => {
    // `--web-port` should not satisfy a check for `--web` (would be a footgun
    // since users expect `--web` to be exact).
    expect(hasFlag(['--web-port=3000'], ['--web'])).toBe(false);
  });

  it('returns false when no flag matches', () => {
    expect(hasFlag(['serve'], ['--verbose'])).toBe(false);
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

// D10 (4.1) — one test per precedence rung: CLI flag > env var > config.yaml
// > default.

describe('resolveWebHost', () => {
  it('falls back to the default when nothing is set', () => {
    expect(resolveWebHost([], {}, null)).toBe('127.0.0.1');
  });

  it('config.yaml overrides the default', () => {
    const config = { ...BASE, web: { host: '10.0.0.5' } } satisfies EthosConfig;
    expect(resolveWebHost([], {}, config)).toBe('10.0.0.5');
  });

  it('env var overrides config.yaml', () => {
    const config = { ...BASE, web: { host: '10.0.0.5' } } satisfies EthosConfig;
    expect(resolveWebHost([], { ETHOS_WEB_HOST: '0.0.0.0' }, config)).toBe('0.0.0.0');
  });

  it('CLI flag overrides both env var and config.yaml', () => {
    const config = { ...BASE, web: { host: '10.0.0.5' } } satisfies EthosConfig;
    expect(
      resolveWebHost(['--web-host', '192.168.1.1'], { ETHOS_WEB_HOST: '0.0.0.0' }, config),
    ).toBe('192.168.1.1');
  });
});

describe('resolveWebPort', () => {
  it('falls back to WEB_PORT_DEFAULT when nothing is set', () => {
    expect(resolveWebPort([], {}, null)).toBe(WEB_PORT_DEFAULT);
  });

  it('config.yaml overrides the default', () => {
    const config = { ...BASE, web: { port: 4000 } } satisfies EthosConfig;
    expect(resolveWebPort([], {}, config)).toBe(4000);
  });

  it('env var overrides config.yaml', () => {
    const config = { ...BASE, web: { port: 4000 } } satisfies EthosConfig;
    expect(resolveWebPort([], { ETHOS_WEB_PORT: '5000' }, config)).toBe(5000);
  });

  it('CLI flag overrides both env var and config.yaml', () => {
    const config = { ...BASE, web: { port: 4000 } } satisfies EthosConfig;
    expect(resolveWebPort(['--web-port', '6000'], { ETHOS_WEB_PORT: '5000' }, config)).toBe(6000);
  });

  it('falls back past an invalid env var to config.yaml', () => {
    const config = { ...BASE, web: { port: 4000 } } satisfies EthosConfig;
    expect(resolveWebPort([], { ETHOS_WEB_PORT: 'nope' }, config)).toBe(4000);
  });
});

describe('resolveCorsOrigins', () => {
  it('is unset when nothing is set (no CORS)', () => {
    expect(resolveCorsOrigins({}, null)).toBeUndefined();
  });

  it('config.yaml sets it', () => {
    const config = {
      ...BASE,
      web: { corsOrigins: 'https://chat.example.com' },
    } satisfies EthosConfig;
    expect(resolveCorsOrigins({}, config)).toBe('https://chat.example.com');
  });

  it('env var overrides config.yaml (no CLI flag exists for this one)', () => {
    const config = {
      ...BASE,
      web: { corsOrigins: 'https://chat.example.com' },
    } satisfies EthosConfig;
    expect(resolveCorsOrigins({ ETHOS_API_CORS_ORIGINS: '*' }, config)).toBe('*');
  });
});

describe('a2aZeroSkillsWarning (T0.1 — the headline bug)', () => {
  it('fires when the personality exposes zero skills', () => {
    const warning = a2aZeroSkillsWarning('engineer', 0);
    expect(warning).not.toBeNull();
    expect(warning).toContain('engineer');
    expect(warning).toContain('FORBIDDEN_SCOPE');
    expect(warning).toContain('ethos.exposeToAgents');
  });

  it('is silent once at least one skill is exposed', () => {
    expect(a2aZeroSkillsWarning('engineer', 1)).toBeNull();
    expect(a2aZeroSkillsWarning('engineer', 5)).toBeNull();
  });

  it('does not tell the operator to set skillsDirs (loader-populated, not a config key)', () => {
    const warning = a2aZeroSkillsWarning('engineer', 0);
    expect(warning?.toLowerCase()).not.toContain('skillsdirs');
  });
});
