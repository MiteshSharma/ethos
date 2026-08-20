// @ethosagent/worker-router — where a worker's question goes.
//
// Runner-agnostic (D14): a cached answer, an auto-resolving capability, or a
// human, decided from an `InteractionRequest` alone. Nothing here knows Pi
// exists — the Pi gate is one caller of `InteractionRouter.route()`, and a
// second harness is a second caller, not a second router.
//
// See plan/phases/pi-delegation.md §3.5 (the routing algorithm), §4.5 (the
// kind→route policy and the `secret` rule), D16 (open kinds), D17 (answer
// scope).

export {
  type ClarifyEscalatorDeps,
  createClarifyEscalator,
  DEFAULT_ESCALATION_TIMEOUT_MS,
  RUN_SCOPE_ANSWER,
} from './clarify-escalator';
export type { CapabilityHandler, CapabilityRegistry } from './registry';
export {
  type InteractionEscalator,
  InteractionRouter,
  type InteractionRouterOptions,
} from './router';
export { createSecretHandler, SECRET_KIND, SecretUnavailableError } from './secret';
