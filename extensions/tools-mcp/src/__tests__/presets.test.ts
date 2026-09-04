import { describe, expect, it } from 'vitest';
import { getPreset, MCP_PRESETS } from '../presets';

describe('MCP_PRESETS', () => {
  it('every preset has all required fields', () => {
    for (const [key, preset] of Object.entries(MCP_PRESETS)) {
      expect(preset.name).toBe(key);
      expect(typeof preset.description).toBe('string');
      expect(preset.description.length).toBeGreaterThan(0);
      expect(typeof preset.command).toBe('string');
      expect(preset.command.length).toBeGreaterThan(0);
      expect(Array.isArray(preset.args)).toBe(true);
      expect(Array.isArray(preset.envVars)).toBe(true);
      expect(Array.isArray(preset.argVars)).toBe(true);
      expect(typeof preset.category).toBe('string');
      expect(preset.category.length).toBeGreaterThan(0);
    }
  });

  it('contains the five standard presets', () => {
    expect(Object.keys(MCP_PRESETS).sort()).toEqual([
      'fetch',
      'filesystem',
      'git',
      'google-calendar',
      'memory',
    ]);
  });

  it('does not contain sqlite', () => {
    // Removed on purpose: upstream archived the server (last release April
    // 2025), it is Python-only, and the npm package the old preset named
    // (`@modelcontextprotocol/server-sqlite`) has never existed.
    expect(MCP_PRESETS.sqlite).toBeUndefined();
  });

  // The invocations below were verified against npm/PyPI and the upstream
  // README on 2026-09-01. Pinning them here so a regression is a test failure
  // rather than a server that silently refuses every tool call.

  it('filesystem takes its allowed path as a positional arg, not an env var', () => {
    const preset = MCP_PRESETS.filesystem;
    expect(preset).toBeDefined();
    expect(preset?.command).toBe('npx');
    expect(preset?.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem']);
    expect(preset?.argVars).toEqual(['ALLOWED_PATH']);
    // ALLOWED_PATHS in the environment was a no-op — the server never read it.
    expect(preset?.envVars).toEqual([]);
  });

  it('git runs the Python server via uvx with --repository', () => {
    const preset = MCP_PRESETS.git;
    expect(preset?.command).toBe('uvx');
    expect(preset?.args).toEqual(['mcp-server-git', '--repository']);
    expect(preset?.argVars).toEqual(['GIT_REPO_PATH']);
    expect(preset?.envVars).toEqual([]);
    expect(preset?.description).toContain('uvx');
  });

  it('fetch runs the Python server via uvx and needs no user input', () => {
    const preset = MCP_PRESETS.fetch;
    expect(preset?.command).toBe('uvx');
    expect(preset?.args).toEqual(['mcp-server-fetch']);
    expect(preset?.argVars).toEqual([]);
    expect(preset?.envVars).toEqual([]);
    expect(preset?.description).toContain('uvx');
  });

  it('memory declares the MEMORY_FILE_PATH env var it actually reads', () => {
    const preset = MCP_PRESETS.memory;
    expect(preset?.command).toBe('npx');
    expect(preset?.args).toEqual(['-y', '@modelcontextprotocol/server-memory']);
    expect(preset?.envVars).toEqual(['MEMORY_FILE_PATH']);
    expect(preset?.argVars).toEqual([]);
  });

  it('google-calendar runs the community npm server and needs an OAuth client JSON', () => {
    const preset = MCP_PRESETS['google-calendar'];
    expect(preset?.command).toBe('npx');
    // `@cocal/...`, not a `@google/` or `@modelcontextprotocol/` package —
    // this is the community server, verified on npm at 2.6.3 on 2026-09-04.
    expect(preset?.args).toEqual(['-y', '@cocal/google-calendar-mcp']);
    // The credential is a PATH to a Google Cloud OAuth client JSON in the
    // environment, not a positional arg and not a client id/secret pair.
    expect(preset?.envVars).toEqual(['GOOGLE_OAUTH_CREDENTIALS']);
    expect(preset?.argVars).toEqual([]);
    // Local presets have their own three-label scheme; 'Productivity' belongs
    // to the remote catalog, which renders in a different dropdown.
    expect(preset?.category).toBe('Utilities');
  });

  it('names no npm package that does not exist', () => {
    // The three dead `@modelcontextprotocol/server-*` packages the old table
    // shipped. All 404 on npm.
    const allArgs = Object.values(MCP_PRESETS).flatMap((p) => p.args);
    expect(allArgs).not.toContain('@modelcontextprotocol/server-git');
    expect(allArgs).not.toContain('@modelcontextprotocol/server-sqlite');
    expect(allArgs).not.toContain('@modelcontextprotocol/server-fetch');
  });
});

describe('getPreset', () => {
  it('returns the preset for a known name', () => {
    const preset = getPreset('filesystem');
    expect(preset).toBeDefined();
    expect(preset?.name).toBe('filesystem');
    expect(preset?.command).toBe('npx');
    expect(preset?.args).toContain('@modelcontextprotocol/server-filesystem');
  });

  it('returns undefined for an unknown name', () => {
    expect(getPreset('does-not-exist')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(getPreset('')).toBeUndefined();
  });
});
