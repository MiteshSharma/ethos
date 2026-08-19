import type { RunnerCapabilities } from '@ethosagent/types';

/** The name this runner registers under in the `JobRunnerRegistry`. */
export const PI_RUNNER_NAME = 'pi';

/**
 * What the Pi harness can actually do — the literal recorded by the Phase 0
 * spike (2026-08-19, `pi` 0.84.2) and shipped here verbatim. Every field was
 * observed live, not inferred from docs; the comments are the evidence.
 */
export const PI_RUNNER_CAPABILITIES: RunnerCapabilities = {
  // Pi's protocol-native interaction primitives — the ExtensionUI dialog
  // methods surfaced as `extension_ui_request.method` in --mode rpc. There is
  // NO native secret/oauth/file/pick/form/image-view vocabulary. Any richer
  // domain kind Ethos wants has to be synthesized by OUR OWN extension code
  // deciding which dialog method + title/options to present for a given
  // tool_call; Pi does not know these domain kinds exist.
  interactionKinds: ['select', 'confirm', 'input', 'editor'],
  // 'once' is the only protocol-native scope — extension_ui_response carries
  // no remember/scope field. 'run' and 'always' are achievable but entirely
  // our responsibility: the gate extension caches prior answers itself and
  // skips re-prompting for a cached (tool, kind) pair. Not built yet — the
  // scope cache is the router's job (Phase 4).
  answerScopes: ['once', 'run', 'always'],
  // No attach/pty path exists at any sandboxing level (CONFIRMED negative) —
  // --mode rpc and the interactive TUI are mutually exclusive process modes
  // with no live switch, and session files are unlocked, so a second process
  // is an unguarded race, not a supported second window.
  takeover: 'none',
  // CONFIRMED live: killing the host mid-tool-call and respawning with the
  // same --session-id restores full history with the interrupted tool call
  // left dangling (assistant toolCall persisted, no toolResult) — NOT
  // auto-re-executed. Side effects are not replayed.
  resume: 'session',
  // CONFIRMED live: `{"type":"steer",...}` queues, fires queue_update,
  // delivers after the in-flight tool call's turn completes, drains cleanly.
  steer: true,
  // No built-in sandbox by design (documented, and confirmed live: a write to
  // /etc succeeded INSIDE the container). Containment is 100% the container
  // boundary — which is why the host is spawned through the same docker
  // execution backend personality command execution already uses.
  sandbox: 'external',
  transport:
    'JSON Lines over stdio (pi --mode rpc) — one command/event object per line, LF-delimited only',
};
