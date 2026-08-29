import type { CapabilityHandler } from './registry';

/** The one kind §4.5 makes an unconditional rule about. */
export const SECRET_KIND = 'secret';

/**
 * Raised instead of asking a human for secret material. The run fails; it does
 * not prompt.
 */
export class SecretUnavailableError extends Error {
  readonly code = 'SECRET_UNAVAILABLE' as const;
  constructor(detail: string) {
    super(`SECRET_UNAVAILABLE: ${detail}`);
    this.name = 'SecretUnavailableError';
  }
}

/**
 * §4.5's `secret` row: **never** falls back to asking you.
 *
 * Clarify rows are persisted to disk and the answer returns through a tool
 * result into the model's transcript, so a password typed into that card is a
 * password written into session history. Auto-resolve or fail — there is no
 * third option.
 *
 * STUB, deliberately: there is no keychain (or any other secret backend) wired
 * to this in the codebase today, and no runner currently emits this kind — Pi's
 * whole interaction vocabulary is `select`/`confirm`/`input`/`editor` (Phase 0
 * spike, §6). What ships is the STRUCTURE: the registry can express "this kind
 * never escalates", and the failure it produces is the documented one. Wiring a
 * real resolution source is the only thing left to change here.
 */
export function createSecretHandler(): CapabilityHandler {
  return {
    // Always true, and that is the rule: claiming the kind is what keeps it
    // away from `ClarifyBridge`.
    canAutoResolve: () => true,
    resolve: (req) =>
      Promise.reject(
        new SecretUnavailableError(
          `no secret backend is wired for kind '${req.kind}'${req.toolName ? ` (tool '${req.toolName}')` : ''}; refusing to ask a human for secret material`,
        ),
      ),
  };
}
