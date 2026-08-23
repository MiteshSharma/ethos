// @ethosagent/execution-coding-agents — real ACP-native coding-agent CLIs as
// background-job runners.
//
// Scope: a real Agent Client Protocol (https://agentclientprotocol.com/)
// client speaking `initialize` / `session/new` / `session/prompt` /
// `session/update` / `session/request_permission` over stdio, the sandboxed
// container, and the per-run worktree. Nothing runner-agnostic lives here —
// the elicitation router and capability registry are Ethos-side and
// harness-neutral by design (the exact same `InteractionRouter`
// `execution-pi` already routes through), so a second harness reuses them
// without touching this package.
//
// D-ACP1: `extensions/execution-pi/` is untouched by this package — no shared
// file, no shim, no import in either direction.

export {
  AcpConnection,
  type AcpNotificationHandler,
  type AcpRequestHandler,
} from './acp-connection';
export {
  type AcpGateAnswer,
  type AcpGatePolicy,
  type AcpGateRequest,
  createAutoApproveGate,
  createRouterGate,
} from './acp-gate';
export {
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  type AcpContentBlock,
  type AcpInitializeParams,
  type AcpInitializeResult,
  type AcpNewSessionParams,
  type AcpNewSessionResult,
  type AcpPermissionOption,
  type AcpPermissionOptionKind,
  type AcpPromptParams,
  type AcpPromptResult,
  type AcpRequestPermissionOutcome,
  type AcpRequestPermissionParams,
  type AcpRequestPermissionResult,
  type AcpSessionNotificationParams,
  type AcpSessionUpdate,
  type AcpStopReason,
  type AcpToolCall,
  type AcpToolCallStatus,
  type AcpToolCallUpdate,
  JsonlReader,
} from './acp-protocol';
export {
  agentBinaryAvailable,
  claudeCliAvailable,
} from './availability';
export {
  acpRunnerCapabilities,
  CLAUDE_CODE_ACP_CAPABILITIES,
  CLAUDE_CODE_ACP_RUNNER_NAME,
} from './capabilities';
export { type AcpHostSpec, runAcpHost, type SpawnFn } from './host';
export { AcpJobRunner, type AcpJobRunnerDeps } from './runner';
export { AcpEventTranslator } from './translate';
export {
  type AcpWorkspacePaths,
  acpWorkspacePaths,
  assertWorkspaceInReach,
  prepareWorkspace,
  WorkspaceOutOfReachError,
} from './worktree';
