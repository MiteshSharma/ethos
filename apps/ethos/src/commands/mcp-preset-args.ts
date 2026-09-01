// Argv assembly for `ethos mcp add --preset`.
//
// Lives beside `mcp.ts` rather than inside it because `mcp.ts` pulls in the
// whole MCP server surface (mcp-server, session-sqlite, wiring) at import
// time, which a unit test cannot resolve in isolation. The type import below
// is erased at runtime, so this module stays free of that graph.

import type { McpPreset } from '@ethosagent/tools-mcp';

export type PresetArgsResult = { ok: true; args: string[] } | { ok: false; error: string };

/**
 * Collect the `--arg NAME=value` pairs out of `ethos mcp add`'s argv.
 *
 * A preset's positional value is NOT an environment variable — it lands on the
 * command line. Same parse shape as `--env` (KEY=value, repeatable, split on
 * the first `=`), separate destination. `parseAddArgs` in `mcp.ts` is the only
 * production caller; it lives here so a unit test can reach the real parser
 * rather than a copy of it.
 */
export function collectArgFlags(argv: string[]): Record<string, string> {
  const argValues: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    // `--args` hands the rest of argv to the server being registered, so an
    // `--arg` after it belongs to that server. Matches where `parseAddArgs`
    // stops interpreting flags.
    if (argv[i] === '--args') break;
    if (argv[i] !== '--arg') continue;
    const val = argv[i + 1];
    if (val) {
      const eqIdx = val.indexOf('=');
      if (eqIdx > 0) argValues[val.slice(0, eqIdx)] = val.slice(eqIdx + 1);
    }
    i++;
  }
  return argValues;
}

/**
 * Build the argv for a preset: `preset.args` followed by the user's `--arg`
 * values, in `preset.argVars` declaration order.
 *
 * A preset that declares `argVars` and gets none is refused. A filesystem
 * server registered with no allowed path starts, reports "Started without
 * allowed directories", and then fails every tool call — a silent breakage
 * that is worse than a loud one.
 */
export function buildPresetArgs(
  preset: McpPreset,
  argValues: Record<string, string>,
  serverName: string,
): PresetArgsResult {
  const unknown = Object.keys(argValues).filter((key) => !preset.argVars.includes(key));
  if (unknown.length > 0) {
    const accepted =
      preset.argVars.length > 0
        ? `Accepted: ${preset.argVars.join(', ')}`
        : 'This preset takes no --arg values.';
    return {
      ok: false,
      error: `Unknown --arg for preset '${preset.name}': ${unknown.join(', ')}\n${accepted}`,
    };
  }

  const missing = preset.argVars.filter((key) => !(argValues[key] ?? '').trim());
  if (missing.length > 0) {
    const flags = missing.map((key) => `--arg ${key}=<value>`).join(' ');
    return {
      ok: false,
      error:
        `Preset '${preset.name}' requires ${missing.map((k) => `--arg ${k}`).join(', ')}.\n` +
        `Example: ethos mcp add ${serverName} --preset ${preset.name} ${flags}`,
    };
  }

  const supplied = preset.argVars.map((key) => (argValues[key] ?? '').trim());
  return { ok: true, args: [...preset.args, ...supplied] };
}
