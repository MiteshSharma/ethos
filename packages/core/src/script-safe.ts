import type { PersonalityConfig, ToolRegistry } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// SCRIPT_SAFE — the static exclusion policy for the script-callable tool
// surface (tools-as-code-api plan, Lane C). A script running inside a
// `run_code` sandbox may call `scriptCallable = personality.toolset ∩
// SCRIPT_SAFE` — a pure derivation, never a PersonalityConfig field. The
// ScriptToolBridge (Lane B) and the character sheet (Lane G) both consume
// `scriptCallableFor`, so the displayed surface cannot drift from the
// enforced one.
//
// The policy works off metadata available at the core layer only: the
// tool's `toolset` group, the registry's pluginId tag, and naming
// conventions (`mcp__*`, `clarify`). It never imports extension packages.
// ---------------------------------------------------------------------------

/** Why a tool is excluded from the script-callable surface. */
export type ScriptExclusionCategory =
  | 'code'
  | 'delegation'
  | 'mcp'
  | 'plugin'
  | 'clarify'
  | 'credentials';

const EXCLUSION_REASONS: Record<ScriptExclusionCategory, string> = {
  code: 'code-execution tools are not script-callable — recursion guard (a script cannot start a script)',
  delegation:
    'delegation tools are not script-callable — a script has no identity in the spawn-depth ledger',
  mcp: 'MCP tools are not script-callable at v1',
  plugin: 'plugin tools are not script-callable at v1',
  clarify: 'clarify is not script-callable — a script waiting on a human is a hung container',
  credentials:
    'credential-returning tools are not script-callable — their results can carry secret ' +
    'material (host environment via terminal, raw session transcripts via debug tools), ' +
    'which must not reach untrusted sandboxed code',
};

/** Tool metadata the policy inspects — all of it available at the core layer. */
export interface ScriptSafeToolMeta {
  /** The tool's `toolset` group (e.g. 'code', 'delegation', 'file'). */
  toolset?: string;
  /** The plugin that registered the tool, per `ToolRegistry.getPluginId`. */
  pluginId?: string;
}

/**
 * The static exclusion policy. Returns the exclusion category for a tool
 * that must NOT be callable from a script, or `null` when the tool is
 * script-safe (subject to the personality allowlist, enforced elsewhere).
 */
export function scriptExclusionFor(
  toolName: string,
  meta: ScriptSafeToolMeta = {},
): ScriptExclusionCategory | null {
  if (toolName.startsWith('mcp__')) return 'mcp';
  if (meta.pluginId !== undefined) return 'plugin';
  // Recursion guard: run_code, run_tests, lint — exec-posture tools whose
  // container/host routing assumes a top-level call.
  if (meta.toolset === 'code') return 'code';
  // delegate_task, mixture_of_agents, route_to_agent, dispatch_team,
  // broadcast_to_agents, task_* (and list_team, which rides along) all
  // declare `toolset: 'delegation'` — spawning has no depth ledger for a
  // script caller.
  if (meta.toolset === 'delegation') return 'delegation';
  // Lane F verify-first #5 (2026-08 audit): `terminal`'s host-exec path
  // inherits the full host environment (scoped-process defaults to
  // process.env), so its result can echo provider keys; `debug` tools
  // (get_session_events / get_observability) replay raw, unredacted
  // transcript content from ANY stored session. Both would hand credential
  // material to an untrusted script — excluded as a category.
  if (meta.toolset === 'terminal' || meta.toolset === 'debug') return 'credentials';
  // Blocks the turn on an interactive surface mid-script.
  if (toolName === 'clarify') return 'clarify';
  return null;
}

/**
 * The script-side error for a call to an excluded tool. Names the exclusion
 * category so a script author can tell policy apart from a generic failure.
 */
export function scriptExclusionError(toolName: string, category: ScriptExclusionCategory): string {
  return `Tool ${toolName} is not script-callable (excluded category: ${category}). ${EXCLUSION_REASONS[category]}`;
}

/**
 * Pure derivation of the script-callable surface for a personality:
 * `personality.toolset ∩ SCRIPT_SAFE`, gated on `run_code` itself being
 * reachable — a personality that cannot run a script has no script surface
 * at all. Returns sorted tool names.
 *
 * The allowlist rule mirrors `toDefinitions`/`executeParallel`: the toolset
 * gates built-in tools by exact name; MCP and plugin tools bypass the name
 * allowlist but are excluded by the policy above anyway.
 */
export function scriptCallableFor(
  personality: Pick<PersonalityConfig, 'toolset'>,
  registry: Pick<ToolRegistry, 'getAvailable' | 'getPluginId'>,
): string[] {
  const allowed = personality.toolset;
  const permitted = registry.getAvailable().filter((tool) => {
    const isMcpOrPluginTool =
      tool.name.startsWith('mcp__') || registry.getPluginId?.(tool.name) !== undefined;
    if (!isMcpOrPluginTool && !tool.alwaysInclude && allowed && !allowed.includes(tool.name)) {
      return false;
    }
    return true;
  });
  if (!permitted.some((tool) => tool.name === 'run_code')) return [];
  return permitted
    .filter(
      (tool) =>
        scriptExclusionFor(tool.name, {
          toolset: tool.toolset,
          pluginId: registry.getPluginId?.(tool.name),
        }) === null,
    )
    .map((tool) => tool.name)
    .sort();
}
