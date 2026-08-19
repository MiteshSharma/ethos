// @ethosagent/execution-pi — the Pi harness as a background-job runner.
//
// Scope: Pi host spawn/supervision, the stdio JSON-RPC transport, the sandboxed
// container, and the per-run worktree. Nothing runner-agnostic lives here — the
// elicitation router and capability registry are Ethos-side and harness-neutral
// by design, so a second harness reuses them without touching this package.

export {
  defaultPiConfigDir,
  piBinaryAvailable,
  piCredentialsPresent,
} from './availability';
export { PI_RUNNER_CAPABILITIES, PI_RUNNER_NAME } from './capabilities';
export {
  createAutoApproveGate,
  type PiGateAnswer,
  type PiGatePolicy,
  type PiGateRequest,
  parseGateTitle,
} from './gate';
export { type PiHostSpec, runPiHost } from './host';
export { JsonlReader, type PiCommand, type PiEvent, toolResultText } from './protocol';
export { PiJobRunner, type PiJobRunnerDeps } from './runner';
export { PiEventTranslator } from './translate';
export {
  assertWorkspaceInReach,
  type PiWorkspacePaths,
  piWorkspacePaths,
  prepareWorkspace,
  WorkspaceOutOfReachError,
} from './worktree';
