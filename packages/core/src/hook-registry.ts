import type { ClaimingHooks, HookRegistry, ModifyingHooks, VoidHooks } from '@ethosagent/types';

type AnyHandler = (...args: unknown[]) => Promise<unknown>;

interface RegisteredHandler {
  handler: AnyHandler;
  pluginId?: string;
  failurePolicy: 'fail-open' | 'fail-closed';
}

/** Returns true when a handler should fire given the allowedPlugins filter. */
function isAllowed(h: RegisteredHandler, allowedPlugins: string[] | undefined): boolean {
  if (allowedPlugins === undefined) return true; // no filter — fire all
  if (!h.pluginId) return true; // built-in handler — always fires
  return allowedPlugins.includes(h.pluginId);
}

export class DefaultHookRegistry implements HookRegistry {
  private readonly voidHandlers = new Map<string, RegisteredHandler[]>();
  private readonly modifyingHandlers = new Map<string, RegisteredHandler[]>();
  private readonly claimingHandlers = new Map<string, RegisteredHandler[]>();

  registerVoid<K extends keyof VoidHooks>(
    name: K,
    handler: (payload: VoidHooks[K]) => Promise<void>,
    opts?: { pluginId?: string; failurePolicy?: 'fail-open' | 'fail-closed' },
  ): () => void {
    const entry: RegisteredHandler = {
      handler: handler as AnyHandler,
      pluginId: opts?.pluginId,
      failurePolicy: opts?.failurePolicy ?? 'fail-open',
    };
    const list = this.voidHandlers.get(name) ?? [];
    list.push(entry);
    this.voidHandlers.set(name, list);
    return () => this.remove(this.voidHandlers, name, entry);
  }

  registerModifying<K extends keyof ModifyingHooks>(
    name: K,
    handler: (payload: ModifyingHooks[K][0]) => Promise<Partial<ModifyingHooks[K][1]> | null>,
    opts?: { pluginId?: string },
  ): () => void {
    const entry: RegisteredHandler = {
      handler: handler as AnyHandler,
      pluginId: opts?.pluginId,
      failurePolicy: 'fail-open',
    };
    const list = this.modifyingHandlers.get(name) ?? [];
    list.push(entry);
    this.modifyingHandlers.set(name, list);
    return () => this.remove(this.modifyingHandlers, name, entry);
  }

  registerClaiming<K extends keyof ClaimingHooks>(
    name: K,
    handler: (payload: ClaimingHooks[K][0]) => Promise<ClaimingHooks[K][1]>,
    opts?: { pluginId?: string },
  ): () => void {
    const entry: RegisteredHandler = {
      handler: handler as AnyHandler,
      pluginId: opts?.pluginId,
      failurePolicy: 'fail-open',
    };
    const list = this.claimingHandlers.get(name) ?? [];
    list.push(entry);
    this.claimingHandlers.set(name, list);
    return () => this.remove(this.claimingHandlers, name, entry);
  }

  // Void hooks: all handlers run in parallel via Promise.allSettled.
  // Failures are logged but never propagate (fail-open by default).
  // allowedPlugins gates plugin-registered handlers; built-in handlers always fire.
  async fireVoid<K extends keyof VoidHooks>(
    name: K,
    payload: VoidHooks[K],
    allowedPlugins?: string[],
  ): Promise<void> {
    const handlers = (this.voidHandlers.get(name) ?? []).filter((h) =>
      isAllowed(h, allowedPlugins),
    );
    await Promise.allSettled(handlers.map((h) => h.handler(payload)));
  }

  // Modifying hooks: handlers run sequentially; results are merged (first non-null value per key wins).
  async fireModifying<K extends keyof ModifyingHooks>(
    name: K,
    payload: ModifyingHooks[K][0],
    allowedPlugins?: string[],
  ): Promise<ModifyingHooks[K][1]> {
    const handlers = (this.modifyingHandlers.get(name) ?? []).filter((h) =>
      isAllowed(h, allowedPlugins),
    );
    const merged: Record<string, unknown> = {};
    for (const h of handlers) {
      try {
        const result = await h.handler(payload);
        if (result && typeof result === 'object') {
          for (const [k, v] of Object.entries(result)) {
            if (!(k in merged) && v !== null && v !== undefined) {
              merged[k] = v;
            }
          }
        }
      } catch {
        // fail-open: continue with other handlers
      }
    }
    return merged as ModifyingHooks[K][1];
  }

  // Claiming hooks: handlers run sequentially, stop after first { handled: true }.
  async fireClaiming<K extends keyof ClaimingHooks>(
    name: K,
    payload: ClaimingHooks[K][0],
    allowedPlugins?: string[],
  ): Promise<ClaimingHooks[K][1]> {
    const handlers = (this.claimingHandlers.get(name) ?? []).filter((h) =>
      isAllowed(h, allowedPlugins),
    );
    for (const h of handlers) {
      try {
        const result = (await h.handler(payload)) as ClaimingHooks[K][1];
        if (result && (result as { handled: boolean }).handled) {
          return result;
        }
      } catch {
        // fail-open: try next handler
      }
    }
    return { handled: false } as ClaimingHooks[K][1];
  }

  unregisterPlugin(pluginId: string): void {
    for (const map of [this.voidHandlers, this.modifyingHandlers, this.claimingHandlers]) {
      for (const [name, handlers] of map.entries()) {
        map.set(
          name,
          handlers.filter((h) => h.pluginId !== pluginId),
        );
      }
    }
  }

  private remove(
    map: Map<string, RegisteredHandler[]>,
    name: string,
    entry: RegisteredHandler,
  ): void {
    const list = map.get(name) ?? [];
    map.set(
      name,
      list.filter((h) => h !== entry),
    );
  }
}
