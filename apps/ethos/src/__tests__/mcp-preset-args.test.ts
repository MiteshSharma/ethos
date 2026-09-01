import type { McpPreset } from '@ethosagent/tools-mcp';
import { describe, expect, it } from 'vitest';
import { buildPresetArgs, collectArgFlags } from '../commands/mcp-preset-args';

// ---------------------------------------------------------------------------
// `ethos mcp add --preset` argv assembly.
//
// `--arg NAME=value` supplies a preset's COMMAND-LINE value, which is a
// different thing from `--env KEY=value`. The two servers that need it read
// their configuration positionally: `server-filesystem` takes allowed
// directories as bare positional args, `mcp-server-git` takes them after a
// `--repository` flag that lives in the preset's fixed args.
//
// The `--arg` parse is the same shape as the `--env` parse (KEY=value,
// repeatable, split on the first `=`). It lives in `mcp-preset-args.ts` and is
// exercised here directly: `parseAddArgs` in `mcp.ts` calls the same
// `collectArgFlags`, so there is no second copy to drift — `mcp.ts` itself
// cannot be imported in isolation, see mcp-registry.test.ts.
// ---------------------------------------------------------------------------

const FILESYSTEM: McpPreset = {
  name: 'filesystem',
  description: 'Read/write local files under a required allowed path',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem'],
  envVars: [],
  argVars: ['ALLOWED_PATH'],
  category: 'Developer tools',
};

const GIT: McpPreset = {
  name: 'git',
  description: 'Git repository operations (requires uvx)',
  command: 'uvx',
  args: ['mcp-server-git', '--repository'],
  envVars: [],
  argVars: ['GIT_REPO_PATH'],
  category: 'Developer tools',
};

const MEMORY: McpPreset = {
  name: 'memory',
  description: 'Key-value memory store',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-memory'],
  envVars: ['MEMORY_FILE_PATH'],
  argVars: [],
  category: 'Utilities',
};

const TWO_ARGS: McpPreset = { ...FILESYSTEM, name: 'multi', argVars: ['FIRST', 'SECOND'] };

describe('buildPresetArgs', () => {
  it('appends the positional value after the preset args', () => {
    const result = buildPresetArgs(FILESYSTEM, { ALLOWED_PATH: '/data' }, 'fs');
    expect(result).toEqual({
      ok: true,
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
    });
  });

  it('appends after a flag that lives in the fixed args', () => {
    const result = buildPresetArgs(GIT, { GIT_REPO_PATH: '/repos/myapp' }, 'my-git');
    expect(result).toEqual({ ok: true, args: ['mcp-server-git', '--repository', '/repos/myapp'] });
  });

  it('orders values by argVars declaration, not by the order they were typed', () => {
    const result = buildPresetArgs(TWO_ARGS, { SECOND: 'b', FIRST: 'a' }, 'multi');
    expect(result).toEqual({
      ok: true,
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'a', 'b'],
    });
  });

  it('passes a preset that declares no argVars straight through', () => {
    const result = buildPresetArgs(MEMORY, {}, 'mem');
    expect(result).toEqual({ ok: true, args: ['-y', '@modelcontextprotocol/server-memory'] });
  });

  it('trims surrounding whitespace off a supplied value', () => {
    const result = buildPresetArgs(FILESYSTEM, { ALLOWED_PATH: '  /data  ' }, 'fs');
    expect(result).toEqual({
      ok: true,
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
    });
  });

  it('refuses a required arg that was not supplied, and shows the command', () => {
    // The whole point: a filesystem server registered with no path starts,
    // logs "Started without allowed directories", and fails every tool call.
    const result = buildPresetArgs(FILESYSTEM, {}, 'fs');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('ALLOWED_PATH');
    expect(result.error).toContain('ethos mcp add fs --preset filesystem --arg ALLOWED_PATH=');
  });

  it('refuses a required arg supplied as blank', () => {
    const result = buildPresetArgs(GIT, { GIT_REPO_PATH: '   ' }, 'my-git');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('GIT_REPO_PATH');
  });

  it('names every missing arg when more than one is required', () => {
    const result = buildPresetArgs(TWO_ARGS, {}, 'multi');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('--arg FIRST');
    expect(result.error).toContain('--arg SECOND');
  });

  it('refuses an --arg name the preset does not declare', () => {
    const result = buildPresetArgs(FILESYSTEM, { ALLOWED_PATH: '/data', TYPO: '/x' }, 'fs');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('TYPO');
    expect(result.error).toContain('Accepted: ALLOWED_PATH');
  });

  it('says so plainly when the preset takes no --arg values at all', () => {
    const result = buildPresetArgs(MEMORY, { MEMORY_FILE_PATH: '/tmp/m.json' }, 'mem');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // MEMORY_FILE_PATH is an env var — `--env`, not `--arg`.
    expect(result.error).toContain('takes no --arg values');
  });
});

describe('mcp add — --arg flag parsing', () => {
  it('collects repeated --arg pairs', () => {
    expect(collectArgFlags(['--arg', 'A=1', '--arg', 'B=2'])).toEqual({ A: '1', B: '2' });
  });

  it('splits on the first = so a value may contain one', () => {
    expect(collectArgFlags(['--arg', 'PATH=/a=b'])).toEqual({ PATH: '/a=b' });
  });

  it('ignores a pair with no = and a trailing --arg with no value', () => {
    expect(collectArgFlags(['--arg', 'NOEQUALS'])).toEqual({});
    expect(collectArgFlags(['--arg'])).toEqual({});
  });

  it('does not swallow --args, which is a different flag', () => {
    expect(collectArgFlags(['--args', '-y', 'pkg'])).toEqual({});
  });

  it('leaves an --arg after --args to the server being registered', () => {
    // `--args` hands the rest of argv to the server, which is exactly where
    // `parseAddArgs` stops interpreting flags of its own.
    expect(collectArgFlags(['--arg', 'A=1', '--args', '-y', '--arg', 'B=2'])).toEqual({ A: '1' });
  });
});
