import type { PersonalityConfig, ToolRegistry } from '@ethosagent/types';

// Which of a personality's tools DECLARE a given capability. Read-only — this
// decides nothing and enforces nothing; `resolveCapabilities` remains the
// single derivation that bounds a tool at call time (G-CAP). What this answers
// is the applicability question a boundary report needs: does this personality
// hold any tool that could reach the network at all? A personality with no
// network-declaring tool has nothing for G-NET to protect, and saying
// "enforced" there is noise where "not applicable" is the truth.
//
// It reads the SAME declaration `validateRegistration` checks and
// `resolveCapabilities` intersects, so the reported applicability cannot drift
// from the enforced surface.

/**
 * Names of built-in tools in this personality's reach whose declared
 * `capabilities.network` gives them egress. Sorted.
 *
 * The allowlist rule mirrors `toDefinitions` / `scriptCallableFor`: the toolset
 * gates built-in tools by exact name, `alwaysInclude` tools bypass it. MCP and
 * plugin tools are EXCLUDED — the registry holds every server's tools, not this
 * personality's, and their gates are `mcp_servers` / `plugins`, which a caller
 * can read off the config directly.
 */
export function toolsDeclaringNetwork(
  personality: Pick<PersonalityConfig, 'toolset'>,
  registry: Pick<ToolRegistry, 'getAvailable' | 'getPluginId'>,
): string[] {
  const allowed = personality.toolset;
  return registry
    .getAvailable()
    .filter((tool) => {
      if (tool.name.startsWith('mcp__') || registry.getPluginId?.(tool.name) !== undefined) {
        return false;
      }
      if (!tool.alwaysInclude && allowed && !allowed.includes(tool.name)) return false;
      return tool.capabilities?.network !== undefined;
    })
    .map((tool) => tool.name)
    .sort();
}
