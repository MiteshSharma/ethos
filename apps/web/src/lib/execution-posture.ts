import type { ExecutionPostureWire } from '@ethosagent/web-contracts';

// Pure derivations for the personality-editor Execution tab (Phase 2a, lane
// E2). The posture itself comes from the `personalities.characterSheet` RPC
// (resolved server-side by `buildExecutionPosture`) — nothing here recomputes
// it. These helpers only map that posture onto labels, semantic variants, and
// the override/affordance UI states. Kept framework-free so they unit-test as
// plain `.test.ts` (the web app has no DOM test harness).

export type PostureVariant = 'success' | 'warning' | 'neutral' | 'error';

export interface PostureBadge {
  /** Glyph paired with the label — status is never colour-alone (DESIGN.md). */
  icon: string;
  label: string;
  variant: PostureVariant;
}

/** CSS custom property carrying the semantic colour for a badge variant. */
export function postureColorVar(variant: PostureVariant): string {
  switch (variant) {
    case 'success':
      return 'var(--success)';
    case 'warning':
      return 'var(--warning)';
    case 'error':
      return 'var(--error)';
    case 'neutral':
      return 'var(--text-secondary)';
  }
}

/**
 * The badge for a resolved posture. The docker-absent state takes precedence
 * over the nominal `docker` backend — it is the blocking condition the user
 * must resolve.
 */
export function postureBadge(posture: ExecutionPostureWire): PostureBadge {
  if (posture.dockerAbsent) {
    return { icon: '▲', label: 'Docker required — not running', variant: 'error' };
  }
  if (posture.containerized) {
    return { icon: '▣', label: 'Sandboxed · container', variant: 'success' };
  }
  switch (posture.backend) {
    case 'docker':
      return { icon: '▣', label: 'Sandboxed · Docker', variant: 'success' };
    case 'ssh':
      return { icon: '△', label: 'Remote · runs on ssh host', variant: 'warning' };
    case 'local':
      return { icon: '△', label: 'Un-sandboxed · runs on host', variant: 'warning' };
    case 'none':
      return { icon: '○', label: 'No execution', variant: 'neutral' };
  }
}

/**
 * One-line "why" explaining the computed posture, in calm utility language
 * (DESIGN.md App-UI rules). Derived from the posture the resolver produced.
 */
export function postureWhy(posture: ExecutionPostureWire): string {
  // The resolver's own refusal wording, verbatim. One canonical explanation:
  // composing a second sentence about the same fact is how two surfaces end up
  // disagreeing, and this one would otherwise keep saying tools "run on a
  // remote ssh host" for a posture that refuses to run them at all.
  if (posture.sshRefused) return posture.sshRefused.message;
  if (posture.dockerAbsent) {
    return 'This personality is configured to run its tools in Docker, but the Docker daemon is not reachable. Tools will not run until this is resolved.';
  }
  if (posture.containerized) {
    return 'Ethos is running inside a container, so tools run here — the container is the boundary.';
  }
  switch (posture.backend) {
    case 'docker':
      return 'This personality has execution tools, so they run inside an isolated container with only its declared filesystem reach mounted.';
    case 'ssh':
      // The target is already formatted by the resolver — printed as the
      // operator configured it, never with a defaulted port added here.
      return posture.sshTarget
        ? `Execution tools run on ${posture.sshTarget}. The boundary is remote-host trust, not container mounts.`
        : 'Execution tools run on a remote ssh host. The boundary is remote-host trust, not container mounts.';
    case 'local':
      return 'Execution tools run in this process on the host. There is no container boundary — filesystem and network limits are enforced in-app only.';
    case 'none':
      return 'This personality has no execution tools, so there is no execution backend.';
  }
}

export type OverrideMode = 'auto' | 'docker' | 'host' | 'remote';

export interface OverrideOption {
  value: OverrideMode;
  label: string;
  /** Present when the option cannot be selected; the UI shows it as the reason. */
  disabledReason?: string;
}

/** The default override the editor opens on. */
export const DEFAULT_OVERRIDE: OverrideMode = 'auto';

/**
 * The override choices and their enabled/disabled state. `host` is disabled
 * when the constitution forbids local execution — surfaced via
 * `dockerAbsent.canConsentLocal === false` (the resolver's signal that local
 * consent is withheld). Never silently hidden; the reason is shown.
 */
export function overrideOptions(posture: ExecutionPostureWire): OverrideOption[] {
  const localForbidden =
    posture.dockerAbsent !== undefined && posture.dockerAbsent.canConsentLocal === false;
  const forbiddenReason =
    posture.dockerAbsent?.consentForbiddenReason ??
    'The operator constitution forbids un-sandboxed (local) execution.';
  return [
    { value: 'auto', label: 'Auto' },
    { value: 'docker', label: 'Docker' },
    {
      value: 'host',
      label: 'Host',
      ...(localForbidden ? { disabledReason: forbiddenReason } : {}),
    },
    { value: 'remote', label: 'Remote (ssh)' },
  ];
}

/** True when selecting `host` is blocked for this posture. */
export function isHostOverrideDisabled(posture: ExecutionPostureWire): boolean {
  return overrideOptions(posture).some((o) => o.value === 'host' && o.disabledReason !== undefined);
}

// ---------------------------------------------------------------------------
// Toolset affordance — exec tools "run sandboxed", host-side tools are
// app-confined. Classification by tool name; the exec toolsets are
// terminal / process / code (plan §(b) Toolset tab).
// ---------------------------------------------------------------------------

const EXEC_TOOL_NAMES = new Set(['terminal', 'run_code', 'run_tests', 'lint']);

/** Whether a tool routes through the execution backend (runs sandboxed). */
export function isExecTool(toolName: string): boolean {
  return EXEC_TOOL_NAMES.has(toolName) || toolName.startsWith('process_');
}

export type ToolAffordance =
  | { kind: 'exec'; label: 'runs sandboxed'; link: 'Execution' }
  | { kind: 'host'; label: 'host-side (app-confined)' };

/** The Toolset-tab affordance for a tool — links exec tools to Execution. */
export function toolAffordance(toolName: string): ToolAffordance {
  return isExecTool(toolName)
    ? { kind: 'exec', label: 'runs sandboxed', link: 'Execution' }
    : { kind: 'host', label: 'host-side (app-confined)' };
}

// ---------------------------------------------------------------------------
// Edge-state selection — which edge UI (if any) the Execution tab renders.
// ---------------------------------------------------------------------------

export type EdgeState =
  | { kind: 'docker-absent'; canConsentLocal: boolean; consentForbiddenReason?: string }
  | { kind: 'containerized' }
  | { kind: 'none' };

export function edgeState(posture: ExecutionPostureWire): EdgeState {
  if (posture.dockerAbsent) {
    return {
      kind: 'docker-absent',
      canConsentLocal: posture.dockerAbsent.canConsentLocal,
      ...(posture.dockerAbsent.consentForbiddenReason !== undefined
        ? { consentForbiddenReason: posture.dockerAbsent.consentForbiddenReason }
        : {}),
    };
  }
  if (posture.containerized) {
    return { kind: 'containerized' };
  }
  return { kind: 'none' };
}
