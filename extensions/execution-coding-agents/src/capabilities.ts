import type { RunnerCapabilities } from '@ethosagent/types';
import { ACP_TOOL_KINDS } from './acp-protocol';

/**
 * The name the one provenance-checked agent this phase proves against
 * registers under in the `JobRunnerRegistry` (I1). D-ACP2's "one package, many
 * agents" claim means a second agent gets its OWN name (`runner: 'gemini'`,
 * etc.), decided per the plan's Config shape section — not this constant.
 * Wiring that per-agent registration is T4/I3, out of scope here.
 */
export const CLAUDE_CODE_ACP_RUNNER_NAME = 'claude';

/**
 * `RunnerCapabilities` for a real ACP-native agent, built from what THIS
 * phase actually observed rather than the full spec surface — mirrors
 * `PI_RUNNER_CAPABILITIES`'s discipline of recording only what was checked
 * live, not what the protocol merely allows for.
 *
 * `supportsPermissionRequests` is the one thing that varies per agent: the ACP
 * spec makes `session/request_permission` optional for the agent to invoke
 * (D-ACP3) — Claude Code's adapter uses it (its own README lists "Tool calls
 * (with permission requests)" as a supported feature), but a different
 * ACP-native CLI may never send it at all. An agent that never asks must not
 * be treated as broken: it simply has no interaction surface, exactly like a
 * `return_mode: 'summary'` blocking delegate that never pauses today.
 */
export function acpRunnerCapabilities(opts: {
  supportsPermissionRequests: boolean;
}): RunnerCapabilities {
  return {
    // The vocabulary a `session/request_permission` carries is the tool
    // call's OWN `ToolKind` (read/edit/delete/move/search/execute/think/
    // fetch/switch_mode/other) — `acp-gate.ts` routes it straight through as
    // the `InteractionRequest.kind`, the same way Pi's gate passes its own
    // dialog method through unchanged. An agent that never sends the request
    // at all declares no interaction surface (D-ACP3).
    interactionKinds: opts.supportsPermissionRequests ? ACP_TOOL_KINDS : [],
    // `PermissionOptionKind` is `allow_once | allow_always | reject_once |
    // reject_always` (confirmed from `@agentclientprotocol/sdk@1.3.0`'s
    // schema) — 'once' and 'always' both exist on the wire. 'run' (this run,
    // not persisted) has no direct ACP equivalent; `createRouterGate` below
    // still offers it as a router-level scope (same as Pi's RUN_SCOPE_ANSWER)
    // and picks the nearest ACP option kind when answering back.
    answerScopes: opts.supportsPermissionRequests ? ['once', 'run', 'always'] : ['once'],
    // CONFIRMED negative for now: no ACP method in the schema offers a PTY/
    // terminal attach onto a live agent session (`terminal/*` creates the
    // AGENT's own subprocess terminals, not a host attach point). Until a
    // real agent proves otherwise, stay conservative rather than claim a
    // button the UI cannot back with a real action.
    takeover: 'none',
    // ACP declares `session/load` and `session/resume` methods, and this
    // phase's live handshake check (real `initialize` against
    // @agentclientprotocol/claude-agent-acp@0.70.0) confirms the real agent
    // ADVERTISES support — `agentCapabilities.loadSession: true` and
    // `sessionCapabilities.resume`/`.fork` were present in its actual
    // response. But advertising support is not the same as this phase having
    // exercised a resume round-trip — I1 proves only
    // `initialize`/`session/new`/`session/prompt`. Claim only what was
    // actually checked, same discipline `PI_RUNNER_CAPABILITIES` uses;
    // revisit once I2/I3 exercises resume for real.
    resume: 'none',
    // No mid-turn injection method exists in the ACP schema this phase
    // checked (no steer/interrupt-with-text call — only `session/cancel`,
    // which ends the turn rather than steering it). Conservative `false`
    // until a real agent's capability surface says otherwise.
    steer: false,
    // Containment is the docker execution backend, same mount derivation Pi
    // goes through (D4) — see `worktree.ts`/`runner.ts`. No new safety
    // surface for this package to own.
    sandbox: 'external',
    transport: 'JSON-RPC 2.0 over stdio (Agent Client Protocol)',
  };
}

/** Capabilities for the one agent I1 proves against — Claude Code's official ACP adapter. */
export const CLAUDE_CODE_ACP_CAPABILITIES: RunnerCapabilities = acpRunnerCapabilities({
  supportsPermissionRequests: true,
});
