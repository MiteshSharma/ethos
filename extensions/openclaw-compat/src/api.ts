import type { ContextInjector, MemoryProvider, PlatformAdapter } from '@ethosagent/types';
import type { EthosPluginApi } from '@ethosagent/plugin-sdk';
import {
  translateBeforePromptBuildHook,
  translateCorpusSupplement,
  translateMemoryCapability,
  translateMemoryRuntime,
  translatePromptSectionBuilder,
} from './memory-translator';
import { translateChannelPlugin, unwrapChannelRegistration } from './channel-translator';
import type {
  ChannelPlugin,
  MemoryCorpusSupplement,
  MemoryFlushPlanResolver,
  MemoryPluginCapability,
  MemoryPluginRuntime,
  MemoryPromptSectionBuilder,
  OpenClawHookName,
  OpenClawPluginApiShape,
  OpenClawPluginChannelRegistration,
} from './types';

// ---------------------------------------------------------------------------
// Hook name mapping — OpenClaw → Ethos
// ---------------------------------------------------------------------------

// Void hooks: direct name mapping
const VOID_HOOK_MAP: Partial<Record<string, string>> = {
  session_start: 'session_start',
  agent_end: 'agent_done',
  after_tool_call: 'after_tool_call',
  message_received: 'message_received',
  message_sent: 'message_sent',
  model_call_started: 'before_llm_call',
  model_call_ended: 'after_llm_call',
  subagent_spawned: 'subagent_spawned',
  subagent_ended: 'subagent_ended',
};

// Modifying hooks: require result-shape adaptation
const MODIFYING_HOOK_MAP: Partial<Record<string, string>> = {
  before_tool_call: 'before_tool_call',
  message_sending: 'message_sending',
  subagent_spawning: 'subagent_spawning',
};

// Methods whose calls we accept but cannot translate — log + no-op
const UNSUPPORTED_METHODS = new Set([
  'registerCli',
  'registerContextEngine',
  'registerCompactionProvider',
  'registerAgentHarness',
  'registerHttpRoute',
  'registerGatewayMethod',
  'registerReload',
  'registerNodeHostCommand',
  'registerNodeInvokePolicy',
  'registerSecurityAuditCollector',
  'registerService',
  'registerGatewayDiscoveryService',
  'registerCliBackend',
  'registerTextTransforms',
  'registerConfigMigration',
  'registerMigrationProvider',
  'registerAutoEnableProbe',
  'registerProvider',
  'registerSpeechProvider',
  'registerRealtimeTranscriptionProvider',
  'registerRealtimeVoiceProvider',
  'registerMediaUnderstandingProvider',
  'registerImageGenerationProvider',
  'registerVideoGenerationProvider',
  'registerMusicGenerationProvider',
  'registerWebFetchProvider',
  'registerWebSearchProvider',
  'registerInteractiveHandler',
  'registerAgentToolResultMiddleware',
  'registerSessionExtension',
  'registerDetachedTaskRuntime',
  'registerRuntimeLifecycle',
  'registerAgentEventSubscription',
  'registerTrustedToolPolicy',
  'registerToolMetadata',
  'registerControlUiDescriptor',
  'registerSessionSchedulerJob',
  'registerMemoryEmbeddingProvider',
  'enqueueNextTurnInjection',
  'setRunContext',
  'getRunContext',
  'clearRunContext',
  'resolvePath',
  'onConversationBindingResolved',
  'registerCommand',
  'registerCodexAppServerExtensionFactory',
]);

// ---------------------------------------------------------------------------
// OpenClawPluginApiShim
// ---------------------------------------------------------------------------

export interface OpenClawCompatCallbacks {
  onMemoryProvider?: (pluginId: string, provider: MemoryProvider) => void;
  onPlatformAdapter?: (pluginId: string, adapter: PlatformAdapter) => void;
}

/**
 * Shim that wraps `EthosPluginApi` and exposes the OpenClaw-shaped `api`
 * object passed to `register(api)`. When OpenClaw plugins call registration
 * methods, the shim translates them to Ethos equivalents.
 *
 * Unsupported registration methods (registerCli, registerContextEngine, etc.)
 * log a warning and are silently ignored — the plugin still loads; only the
 * unsupported capability is unavailable.
 */
export class OpenClawPluginApiShim {
  readonly id: string;
  readonly pluginConfig: Record<string, unknown> | undefined;

  // Expose identity + config fields that plugins read from api.*
  readonly name: string;
  readonly version: string | undefined;
  readonly source = 'ethos-compat';
  readonly registrationMode = 'full' as const;

  private readonly ethosApi: EthosPluginApi;
  private readonly callbacks: OpenClawCompatCallbacks;
  private injectorIdx = 0;

  constructor(
    pluginId: string,
    ethosApi: EthosPluginApi,
    callbacks: OpenClawCompatCallbacks = {},
    pluginConfig?: Record<string, unknown>,
  ) {
    this.id = pluginId;
    this.name = pluginId;
    this.version = undefined;
    this.ethosApi = ethosApi;
    this.callbacks = callbacks;
    this.pluginConfig = pluginConfig;
  }

  // -------------------------------------------------------------------------
  // Memory registration
  // -------------------------------------------------------------------------

  registerMemoryCapability(cap: MemoryPluginCapability): void {
    const provider = translateMemoryCapability(cap);
    this.callbacks.onMemoryProvider?.(this.id, provider);
  }

  registerMemoryRuntime(runtime: MemoryPluginRuntime): void {
    const provider = translateMemoryRuntime(runtime);
    this.callbacks.onMemoryProvider?.(this.id, provider);
  }

  registerMemoryPromptSection(builder: MemoryPromptSectionBuilder): void {
    const injector = translatePromptSectionBuilder(
      this.id,
      builder,
      this.injectorIdx++,
    );
    this.ethosApi.registerInjector(injector);
  }

  registerMemoryPromptSupplement(builder: MemoryPromptSectionBuilder): void {
    const injector = translatePromptSectionBuilder(
      this.id,
      builder,
      this.injectorIdx++,
      80, // lower priority than primary section
    );
    this.ethosApi.registerInjector(injector);
  }

  registerMemoryCorpusSupplement(supplement: MemoryCorpusSupplement): void {
    const injector = translateCorpusSupplement(this.id, supplement, this.injectorIdx++);
    this.ethosApi.registerInjector(injector);
  }

  registerMemoryFlushPlan(_resolver: MemoryFlushPlanResolver): void {
    // Ethos has no host-controlled flush plan concept — dropped.
    console.warn(
      `[openclaw-compat] Plugin "${this.id}" called api.registerMemoryFlushPlan(). ` +
        `Flush plan control is not supported in Ethos — using Ethos built-in sync timing.`,
    );
  }

  // -------------------------------------------------------------------------
  // Channel registration
  // -------------------------------------------------------------------------

  registerChannel(reg: OpenClawPluginChannelRegistration | ChannelPlugin): void {
    const channelPlugin = unwrapChannelRegistration(reg);
    const adapter = translateChannelPlugin(channelPlugin);
    this.callbacks.onPlatformAdapter?.(this.id, adapter);
  }

  // -------------------------------------------------------------------------
  // Tool registration — direct pass-through
  // -------------------------------------------------------------------------

  registerTool(tool: unknown): void {
    // OpenClaw tools have a similar shape to Ethos tools but with
    // potential differences in schema format. We attempt a direct register;
    // if the shape is incompatible, we warn.
    try {
      this.ethosApi.registerTool(tool as import('@ethosagent/types').Tool);
    } catch (err) {
      console.warn(
        `[openclaw-compat] Plugin "${this.id}" registerTool() failed: ${String(err)}. ` +
          `The tool was not registered.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Hook subscription — api.on()
  // -------------------------------------------------------------------------

  on(
    hookName: OpenClawHookName,
    handler: (...args: unknown[]) => unknown,
    opts?: { priority?: number; timeoutMs?: number },
  ): void {
    // Special case: before_prompt_build maps to a ContextInjector (not a hook)
    // because Ethos's before_prompt_build modifying hook modifies the system
    // prompt at the hook layer, but memory recall needs injector-level priority.
    if (hookName === 'before_prompt_build') {
      const injector = translateBeforePromptBuildHook(
        this.id,
        handler,
        this.injectorIdx++,
        opts?.priority !== undefined ? opts.priority + 80 : 90,
      );
      this.ethosApi.registerInjector(injector);
      return;
    }

    // session_end — no Ethos equivalent
    if (hookName === 'session_end') {
      console.warn(
        `[openclaw-compat] Plugin "${this.id}" subscribed to "session_end" which has no Ethos ` +
          `equivalent. Session-end cleanup registered by this plugin will not run.`,
      );
      return;
    }

    // Void hooks
    const voidTarget = VOID_HOOK_MAP[hookName];
    if (voidTarget) {
      this.ethosApi.registerVoidHook(
        voidTarget as keyof import('@ethosagent/types').VoidHooks,
        async (payload) => {
          try {
            const p = payload as unknown as Record<string, unknown>;
            await handler(payload, { sessionId: p.sessionId });
          } catch {
            // void hooks swallow errors
          }
        },
      );
      return;
    }

    // Modifying hooks
    const modTarget = MODIFYING_HOOK_MAP[hookName];
    if (modTarget) {
      this.ethosApi.registerModifyingHook(
        modTarget as keyof import('@ethosagent/types').ModifyingHooks,
        async (payload) => {
          try {
            const result = await handler(payload, {});
            if (result && typeof result === 'object') {
              return result as Partial<import('@ethosagent/types').ModifyingHooks[keyof import('@ethosagent/types').ModifyingHooks][1]>;
            }
            return null;
          } catch {
            return null;
          }
        },
      );
      return;
    }

    // Unmapped hook — warn + ignore
    console.warn(
      `[openclaw-compat] Plugin "${this.id}" subscribed to hook "${hookName}" which has no ` +
        `Ethos equivalent. This subscription is ignored.`,
    );
  }

  /** Legacy hook registration (openclaw pre-api.on style). Delegates to api.on(). */
  registerHook(
    events: string | string[],
    handler: (...args: unknown[]) => unknown,
    opts?: { priority?: number },
  ): void {
    const names = Array.isArray(events) ? events : [events];
    for (const name of names) {
      this.on(name, handler, opts);
    }
  }

  // -------------------------------------------------------------------------
  // Runtime / logger stubs — plugins may call api.runtime.X or api.logger.X
  // -------------------------------------------------------------------------

  readonly runtime = {
    // Minimal stub. Plugins call setDingtalkRuntime(api.runtime) to store a
    // reference for later use. The actual runtime methods they call depend on
    // the plugin; they will fail with "method not found" if called on this stub.
    // Full runtime compat is out of scope (U10 from api_surface.md).
  };

  readonly logger = {
    info: (msg: string) => process.stdout.write(`[openclaw/${this.id}] ${msg}\n`),
    warn: (msg: string) => process.stderr.write(`[openclaw/${this.id}] WARN ${msg}\n`),
    error: (msg: string) => process.stderr.write(`[openclaw/${this.id}] ERROR ${msg}\n`),
    debug: (_msg: string) => {},
  };

  readonly config = {};
}

// ---------------------------------------------------------------------------
// Factory — wraps the shim in a Proxy for unknown-method handling
// ---------------------------------------------------------------------------

/**
 * Creates an `OpenClawPluginApiShim` wrapped in a Proxy.
 * The Proxy intercepts any method call not defined on the shim and:
 *   - Logs a warning for known-unsupported OpenClaw API methods
 *   - Returns undefined for anything else
 *
 * This covers the ~30 unsupported methods in UNSUPPORTED_METHODS without
 * requiring boilerplate stubs on the class.
 */
export function createOpenClawApiShim(
  pluginId: string,
  ethosApi: EthosPluginApi,
  callbacks: OpenClawCompatCallbacks = {},
  pluginConfig?: Record<string, unknown>,
): OpenClawPluginApiShape {
  const shim = new OpenClawPluginApiShim(pluginId, ethosApi, callbacks, pluginConfig);
  return new Proxy(shim, {
    get(target, prop) {
      if (prop in target) return (target as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof prop === 'string' && UNSUPPORTED_METHODS.has(prop)) {
        return () => {
          console.warn(
            `[openclaw-compat] Plugin "${pluginId}" called api.${prop}() which is not supported in Ethos. ` +
              `This call is ignored. The plugin may not function fully.`,
          );
        };
      }
      return undefined;
    },
  }) as unknown as OpenClawPluginApiShape;
}

// ---------------------------------------------------------------------------
// Module shape detection
// ---------------------------------------------------------------------------

/**
 * Determine whether a dynamic-import result looks like an OpenClaw plugin
 * module. Returns the `register` function if yes, null if not.
 *
 * OpenClaw plugins can export:
 *   1. `export default definePluginEntry({ register(api) {...} })` → default.register
 *   2. `export default { id, name, register(api) {...} }`           → default.register
 *   3. `export default function register(api) {...}`                 → default (function)
 */
export function extractOpenClawRegister(mod: unknown): ((...args: unknown[]) => unknown) | null {
  if (!mod || typeof mod !== 'object') return null;

  const m = mod as Record<string, unknown>;

  // Check default export first
  const dflt = m.default;
  if (dflt) {
    if (typeof dflt === 'function') return dflt as (...args: unknown[]) => unknown;
    if (typeof dflt === 'object' && dflt !== null) {
      const entry = dflt as Record<string, unknown>;
      if (typeof entry.register === 'function')
        return entry.register as (...args: unknown[]) => unknown;
    }
  }

  // Named export `register`
  if (typeof m.register === 'function') return m.register as (...args: unknown[]) => unknown;

  return null;
}

// ---------------------------------------------------------------------------
// Package.json OpenClaw detection
// ---------------------------------------------------------------------------

/**
 * Returns true if this package.json declares itself as an OpenClaw plugin via:
 *   - `{ "openclaw": { ... } }` block (any content = opt-in)
 *   - NOT required to have openclaw.type — channels just have channels/extensions
 */
export function isOpenClawPackageJson(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const pkg = raw as Record<string, unknown>;
  if (pkg.openclaw && typeof pkg.openclaw === 'object') return true;
  return false;
}

export type { OpenClawPluginApiShape };
