// ---------------------------------------------------------------------------
// Security kernel — the app-facing passthrough (ARCHITECTURE.md §II, §III Law 5)
//
// The kernel (`packages/safety/*`) sits below core and above contracts, and
// wiring is the layer that binds it. Apps import wiring and contracts only, so
// an app that needs a kernel primitive gets it from here rather than reaching
// past the composition root.
//
// This module exists SEPARATELY from `./index` on purpose. Importing the wiring
// barrel loads the whole composition graph — every extension, every provider,
// SQLite, docker — which measures ~7.7s against ~18ms for a kernel package on
// its own. Several of the call sites are lazily-imported CLI subcommands
// (`ethos pairing`, `ethos plugin`, `ethos skills`) whose entire point is not to
// pay that. They import `@ethosagent/wiring/security-kernel`; surfaces already
// on the barrel (gateway, serve) get the same symbols re-exported from it.
//
// The list is deliberately the exact set the first-party apps consume — not an
// `export *` per package. A blanket re-export would make the kernel's whole
// surface an app-facing API and quietly re-open the boundary this module holds.
// ---------------------------------------------------------------------------

export {
  consumeAndAllow,
  generateCode,
  getApprovedSenders,
  initPairingDb,
  revokeApproval,
} from '@ethosagent/safety-channel';
export { INJECTION_DEFENSE_PRELUDE, sanitize, wrapUntrusted } from '@ethosagent/safety-injection';
export {
  canInstall,
  deriveTier,
  type PluginScanPermissions,
  type ScanFinding,
  scanPluginCode,
  scanSkillMd,
  type TrustTier,
} from '@ethosagent/safety-scanner';
