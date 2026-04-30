import type {
  ContextInjector,
  InjectionResult,
  MemoryContext,
  MemoryLoadContext,
  MemoryProvider,
  PromptContext,
} from '@ethosagent/types';
import type {
  MemoryCorpusSupplement,
  MemoryPluginCapability,
  MemoryPluginRuntime,
  MemoryPromptSectionBuilder,
  OpenClawConfig,
} from './types';

// ---------------------------------------------------------------------------
// MemoryPluginCapability → EthosMemoryProvider
// ---------------------------------------------------------------------------

/**
 * Wraps an OpenClaw `MemoryPluginCapability` bundle (registered via
 * `api.registerMemoryCapability()`) as an Ethos `MemoryProvider`.
 *
 * Mapping decisions:
 * - `cap.promptBuilder` → `prefetch` returns the built string as memory content
 * - `cap.runtime` → delegates to `translateMemoryRuntime`
 * - `cap.flushPlanResolver` → dropped; Ethos handles flush timing internally
 * - `cap.publicArtifacts` → dropped; no Ethos equivalent
 * - `sync()` → no-op; OpenClaw flush is controlled by the host, not the plugin
 */
export function translateMemoryCapability(cap: MemoryPluginCapability): MemoryProvider {
  return {
    async prefetch(ctx: MemoryLoadContext): Promise<MemoryContext | null> {
      if (cap.promptBuilder) {
        const lines = cap.promptBuilder({ availableTools: new Set() });
        if (lines.length === 0) return null;
        return { content: lines.join('\n'), source: 'custom', truncated: false };
      }
      if (cap.runtime) {
        return translateMemoryRuntime(cap.runtime).prefetch(ctx);
      }
      return null;
    },
    async sync(): Promise<void> {
      // OpenClaw memory flush is driven by flushPlanResolver (host-controlled).
      // No direct Ethos sync equivalent — updates are written by the plugin's
      // agent_end hook, not through this interface.
    },
  };
}

// ---------------------------------------------------------------------------
// MemoryPluginRuntime → EthosMemoryProvider
// ---------------------------------------------------------------------------

/**
 * Wraps an OpenClaw `MemoryPluginRuntime` (registered via
 * `api.registerMemoryRuntime()`) as an Ethos `MemoryProvider`.
 *
 * `prefetch` calls `runtime.getMemorySearchManager()` and uses the manager's
 * `search()` method (U1 — duck-typed per plan/openclaw_api_surface.md).
 * If the manager doesn't expose `search()` or the context has no query,
 * returns null so the agent proceeds without memory context.
 */
export function translateMemoryRuntime(runtime: MemoryPluginRuntime): MemoryProvider {
  return {
    async prefetch(ctx: MemoryLoadContext): Promise<MemoryContext | null> {
      const cfg = buildMinimalConfig(ctx);
      let manager: Awaited<ReturnType<MemoryPluginRuntime['getMemorySearchManager']>>['manager'];
      try {
        const result = await runtime.getMemorySearchManager({ cfg, agentId: ctx.sessionId });
        if (!result.manager) return null;
        manager = result.manager;
      } catch {
        return null;
      }

      if (!manager.search || !ctx.query) return null;

      try {
        const results = await manager.search({ query: ctx.query, maxResults: 5 });
        if (results.length === 0) return null;
        const content = results.map((r) => r.content).join('\n\n---\n\n');
        return { content, source: 'custom', truncated: false };
      } catch {
        return null;
      }
    },
    async sync(): Promise<void> {
      // Writes are handled by agent_end hooks inside the plugin, not here.
    },
  };
}

// ---------------------------------------------------------------------------
// MemoryPromptSectionBuilder → ContextInjector
// ---------------------------------------------------------------------------

/**
 * Wraps an OpenClaw `MemoryPromptSectionBuilder` (registered via
 * `api.registerMemoryPromptSection()`) as an Ethos `ContextInjector`.
 *
 * The builder synchronously returns lines; the injector prepends them to the
 * system prompt. `priority` defaults to 90 (just below the skills injector).
 */
export function translatePromptSectionBuilder(
  pluginId: string,
  builder: MemoryPromptSectionBuilder,
  idx: number,
  priority = 90,
): ContextInjector {
  return {
    id: `openclaw-${pluginId}-prompt-section-${idx}`,
    priority,
    async inject(_ctx: PromptContext): Promise<InjectionResult | null> {
      const lines = builder({ availableTools: new Set() });
      if (lines.length === 0) return null;
      return { content: lines.join('\n'), position: 'prepend' };
    },
  };
}

// ---------------------------------------------------------------------------
// MemoryCorpusSupplement → ContextInjector
// ---------------------------------------------------------------------------

/**
 * Wraps an OpenClaw `MemoryCorpusSupplement` (registered via
 * `api.registerMemoryCorpusSupplement()`) as a search-based ContextInjector.
 *
 * Uses `ctx.query` from `PromptContext` (extended field) to run a search and
 * inject the top results. Falls back to null when no query is available.
 */
export function translateCorpusSupplement(
  pluginId: string,
  supplement: MemoryCorpusSupplement,
  idx: number,
): ContextInjector {
  return {
    id: `openclaw-${pluginId}-corpus-${idx}`,
    priority: 85,
    async inject(ctx: PromptContext): Promise<InjectionResult | null> {
      const query = (ctx as PromptContext & { query?: string }).query;
      if (!query) return null;
      try {
        const results = await supplement.search({ query, maxResults: 5 });
        if (results.length === 0) return null;
        const content = results.map((r) => r.content).join('\n\n---\n\n');
        return { content, position: 'prepend' };
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// before_prompt_build hook handler → ContextInjector
// ---------------------------------------------------------------------------

/**
 * Wraps an OpenClaw `before_prompt_build` hook handler as a ContextInjector.
 *
 * OpenClaw: `api.on('before_prompt_build', async (event, ctx) => ({ prependContext }))`
 * Ethos: `ContextInjector.inject(ctx) → InjectionResult`
 *
 * The handler receives a minimal event object matching what memory-lancedb-pro
 * passes to its recall injection path.
 */
export function translateBeforePromptBuildHook(
  pluginId: string,
  handler: (...args: unknown[]) => unknown,
  idx: number,
  priority = 90,
): ContextInjector {
  return {
    id: `openclaw-${pluginId}-before-prompt-build-${idx}`,
    priority,
    async inject(ctx: PromptContext): Promise<InjectionResult | null> {
      const event = { availableTools: new Set<string>() };
      const hookCtx = { sessionId: ctx.sessionId, platform: ctx.platform };
      let result: unknown;
      try {
        result = await handler(event, hookCtx);
      } catch {
        return null;
      }
      if (!result || typeof result !== 'object') return null;
      const r = result as Record<string, unknown>;
      if (typeof r.prependContext === 'string' && r.prependContext.length > 0) {
        return { content: r.prependContext, position: 'prepend' };
      }
      if (typeof r.appendContext === 'string' && r.appendContext.length > 0) {
        return { content: r.appendContext, position: 'append' };
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildMinimalConfig(ctx: MemoryLoadContext): OpenClawConfig {
  return {
    agentId: ctx.sessionId,
    platform: ctx.platform,
    sessionKey: ctx.sessionKey,
  };
}
