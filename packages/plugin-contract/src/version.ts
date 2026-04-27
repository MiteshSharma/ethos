// Phase 30.6 — plugin contract version gate.
//
// Plugins declare the contract major they were built against in their
// package.json under `ethos.pluginContractMajor` (an integer). The plugin
// loader checks this against `PLUGIN_CONTRACT_MAJOR` here at load time and
// rejects incompatible plugins with a clear message linking to MIGRATIONS.md.
//
// Bump this number on any breaking change to the plugin contract:
//   - field rename
//   - field removal
//   - required-field addition
// Non-breaking additions (new optional field, additive method on PluginApi)
// stay on the same major.
//
// Deprecation policy is no-overlap: a major bump drops support for the prior
// major in the same release. See `MIGRATIONS.md` header.

export const PLUGIN_CONTRACT_MAJOR = 1;

export interface ContractCompatResult {
  ok: boolean;
  /**
   * One-line user-facing reason. Includes the plugin name (when available),
   * declared major, current major, and a link to MIGRATIONS.md.
   */
  reason?: string;
}

/**
 * True when `declared` is undefined (older plugin without a declaration —
 * loader allows it for backward compat) OR when `declared === current`.
 *
 * Anything else fails. Non-integer or negative declared → fail.
 */
export function checkPluginContractMajor(
  declared: number | undefined,
  current: number = PLUGIN_CONTRACT_MAJOR,
  pluginName = 'plugin',
): ContractCompatResult {
  if (declared === undefined) {
    return { ok: true };
  }
  if (!Number.isInteger(declared) || declared < 0) {
    return {
      ok: false,
      reason: `${pluginName} declared an invalid pluginContractMajor (${String(declared)}); expected a non-negative integer. Current contract major is ${current}. See https://github.com/ethosdev/ethos/blob/main/packages/plugin-contract/MIGRATIONS.md`,
    };
  }
  if (declared !== current) {
    return {
      ok: false,
      reason: `${pluginName} declares pluginContractMajor=${declared}, but Ethos's current plugin contract is major=${current}. Update the plugin per https://github.com/ethosdev/ethos/blob/main/packages/plugin-contract/MIGRATIONS.md`,
    };
  }
  return { ok: true };
}
