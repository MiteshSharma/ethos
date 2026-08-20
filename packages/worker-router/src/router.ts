import type { InteractionAnswer, InteractionRequest, Logger } from '@ethosagent/types';
import { type CapabilityRegistry, DefaultCapabilityRegistry } from './registry';
import { InteractionScopeCache } from './scope-cache';

/**
 * Escalation to a human. Separate from the router so the router itself knows
 * nothing about clarify, surfaces, or jobs-as-rows — `createClarifyEscalator`
 * is the implementation Ethos ships, and a test drives a two-line fake.
 */
export type InteractionEscalator = (
  jobId: string,
  req: InteractionRequest,
) => Promise<InteractionAnswer>;

export interface InteractionRouterOptions {
  escalate: InteractionEscalator;
  logger?: Logger;
}

/**
 * Routes a worker's interaction request: cached answer, auto-resolving
 * capability, or a human — in that order (plan §3.5, verbatim).
 *
 * Runner-agnostic by construction (D14): it takes an `InteractionRequest`, not
 * a transport frame, and nothing in this package imports a harness. Pi's
 * tool-call gate and a hypothetical HTTP permission endpoint are two callers of
 * the same `route()`.
 */
export class InteractionRouter {
  /** Kind → handler. Callers register their capabilities here (D16). */
  readonly registry: CapabilityRegistry = new DefaultCapabilityRegistry();
  private readonly scopeCache = new InteractionScopeCache();
  private readonly escalate: InteractionEscalator;
  private readonly logger: Logger | undefined;

  constructor(opts: InteractionRouterOptions) {
    this.escalate = opts.escalate;
    this.logger = opts.logger;
  }

  /**
   * Answer one request on behalf of `jobId`.
   *
   * Throws only when a handler that CLAIMED the kind fails (the `secret` case:
   * fail closed, never prompt) or when escalation itself fails — a timeout with
   * no default parks the run rather than guessing. Callers translate a throw
   * into their own refusal; they must never read it as "allow".
   */
  async route(jobId: string, req: InteractionRequest): Promise<InteractionAnswer> {
    const cached = this.scopeCache.get(jobId, req.kind, req.toolName);
    if (cached) {
      this.logger?.debug('worker-router: answered from the scope cache', {
        jobId,
        kind: req.kind,
        toolName: req.toolName,
      });
      // The DECISION is the cached one — its `source` records who actually
      // made it — but the correlation id belongs to THIS ask, or the answer
      // lands on a request that was already resolved.
      return { ...cached, requestId: req.requestId };
    }

    const handler = this.registry.lookup(req.kind);
    // A miss is the normal case (D16): an unknown kind degrades to asking a
    // human with whatever `prompt`/`options` the harness supplied.
    const auto = handler !== undefined && (await handler.canAutoResolve(req));
    const answer = auto && handler ? await handler.resolve(req) : await this.escalate(jobId, req);

    if (answer.scope !== 'once') {
      this.scopeCache.remember(jobId, req.kind, req.toolName, answer);
    }
    return answer;
  }

  /**
   * Drop everything remembered for a job. Wired to the executor's terminal
   * transition (`BackgroundExecutor.onComplete`) — a run's allowances die with
   * the run.
   */
  forgetJob(jobId: string): void {
    this.scopeCache.forgetJob(jobId);
  }
}
