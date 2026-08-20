import type { InteractionAnswer, InteractionRequest } from '@ethosagent/types';

/**
 * Answers one kind of interaction without a human — the "invisible tier" of
 * §4.5. A handler that claims a kind OWNS it: if `canAutoResolve` says yes and
 * `resolve` then throws, the router does NOT fall back to asking a human. That
 * is the whole point of the `secret` rule (auto-resolve or fail, never prompt),
 * and a handler that wants the human as a fallback says so by answering
 * `canAutoResolve: false` for that request.
 */
export interface CapabilityHandler {
  canAutoResolve(req: InteractionRequest): boolean | Promise<boolean>;
  resolve(req: InteractionRequest): Promise<InteractionAnswer>;
}

/**
 * Kind → handler, keyed by an OPEN string (D16). A harness that invents a kind
 * we have never seen is the normal case, not an error case: a lookup miss is
 * `undefined`, which the router reads as "ask a human", never as a crash.
 */
export interface CapabilityRegistry {
  /** Returns an unregister function, matching the rest of the repo's registries. */
  register(kind: string, handler: CapabilityHandler): () => void;
  lookup(kind: string): CapabilityHandler | undefined;
  /** Registered kinds — the set a runner can be told Ethos will auto-resolve. */
  list(): string[];
}

export class DefaultCapabilityRegistry implements CapabilityRegistry {
  private readonly handlers = new Map<string, CapabilityHandler>();

  register(kind: string, handler: CapabilityHandler): () => void {
    this.handlers.set(kind, handler);
    return () => {
      if (this.handlers.get(kind) === handler) this.handlers.delete(kind);
    };
  }

  lookup(kind: string): CapabilityHandler | undefined {
    return this.handlers.get(kind);
  }

  list(): string[] {
    return [...this.handlers.keys()];
  }
}
