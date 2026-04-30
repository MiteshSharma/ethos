/**
 * OpenClaw plugin API types — internal to this package.
 * Sourced from plan/openclaw_api_surface.md (verified 2026-04-30).
 * Only the subset needed for memory + channel compat is declared here.
 */

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface OpenClawPluginManifest {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  kind?: 'memory' | 'channel' | 'provider' | 'tool' | 'context-engine';
  activation?: { onStartup?: boolean };
  contracts?: { memoryEmbeddingProviders?: string[] };
  channelConfigs?: Record<string, unknown>;
  commandAliases?: Array<{ name: string; kind: string; cliCommand: string }>;
  skills?: string | string[];
  main?: string;
  configSchema?: Record<string, unknown>;
}

/** `package.json` `openclaw` block. */
export interface OpenClawPackageJsonBlock {
  extensions?: string[];
  channels?: string[];
  channel?: {
    id: string;
    label: string;
    selectionLabel?: string;
    docsPath?: string;
    blurb?: string;
    aliases?: string[];
    order?: number;
  };
  install?: { npmSpec?: string; localPath?: string };
  installDependencies?: boolean;
  compat?: { pluginApi?: string; minGatewayVersion?: string };
}

// ---------------------------------------------------------------------------
// Minimal config stub — OpenClaw passes its full config to plugin methods.
// The shim constructs a minimal object from Ethos's MemoryLoadContext.
// ---------------------------------------------------------------------------

export interface OpenClawConfig {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Memory types
// ---------------------------------------------------------------------------

export type MemoryPromptSectionBuilder = (params: {
  availableTools: Set<string>;
  citationsMode?: string;
}) => string[];

/** Unknown — U1 from plan/openclaw_api_surface.md. Duck-typed at call sites. */
export type RegisteredMemorySearchManager = {
  search?(params: {
    query: string;
    maxResults?: number;
  }): Promise<Array<{ content: string; id?: string; score?: number }>>;
  close?(): Promise<void>;
};

export type MemoryPluginRuntime = {
  getMemorySearchManager(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: 'default' | 'status' | 'cli';
  }): Promise<{ manager: RegisteredMemorySearchManager | null; error?: string }>;
  resolveMemoryBackendConfig?(params: { cfg: OpenClawConfig; agentId: string }): unknown;
  closeAllMemorySearchManagers?(): Promise<void>;
};

export type MemoryFlushPlanResolver = (params: {
  cfg?: OpenClawConfig;
  nowMs?: number;
}) => unknown | null;

export type MemoryPluginPublicArtifactsProvider = {
  listArtifacts(params: { agentId: string; cfg: OpenClawConfig }): Promise<unknown[]>;
};

export type MemoryCorpusSupplement = {
  search(params: {
    query: string;
    maxResults?: number;
  }): Promise<Array<{ id: string; content: string; score?: number }>>;
  get(params: {
    lookup: string;
    fromLine?: number;
    lineCount?: number;
  }): Promise<{ content: string; totalLines?: number } | null>;
};

export type MemoryPluginCapability = {
  promptBuilder?: MemoryPromptSectionBuilder;
  flushPlanResolver?: MemoryFlushPlanResolver;
  runtime?: MemoryPluginRuntime;
  publicArtifacts?: MemoryPluginPublicArtifactsProvider;
};

// ---------------------------------------------------------------------------
// Channel types
// ---------------------------------------------------------------------------

export type ChannelId = string;

export type ChannelMeta = {
  id: ChannelId;
  label: string;
  selectionLabel: string;
  docsPath: string;
  docsLabel?: string;
  blurb: string;
  order?: number;
  aliases?: readonly string[];
  markdownCapable?: boolean;
};

export type ChannelCapabilities = {
  chatTypes: Array<'dm' | 'group' | 'thread'>;
  polls?: boolean;
  reactions?: boolean;
  edit?: boolean;
  unsend?: boolean;
  reply?: boolean;
  media?: boolean;
  threads?: boolean;
  nativeCommands?: boolean;
  blockStreaming?: boolean;
};

export type ChannelLifecycleAdapter = {
  onAccountConfigChanged?(params: {
    prevCfg: OpenClawConfig;
    nextCfg: OpenClawConfig;
    accountId: string;
  }): Promise<void> | void;
  onAccountRemoved?(params: { prevCfg: OpenClawConfig; accountId: string }): Promise<void> | void;
  runStartupMaintenance?(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    log: { info?(msg: string): void; warn?(msg: string): void };
    trigger?: string;
  }): Promise<void> | void;
};

/**
 * Outbound message delivery adapter. U4 from plan/openclaw_api_surface.md.
 * Best-effort shape inferred from real plugins.
 */
export type ChannelOutboundAdapter = {
  send?(params: {
    chatId: string;
    message: { text: string; attachments?: unknown[]; replyToId?: string; parseMode?: string };
    accountId?: string;
  }): Promise<{ messageId?: string; ok?: boolean }>;
};

/**
 * Gateway adapter — handles inbound events from the platform. U3 from surface doc.
 * Best-effort shape inferred from real plugins.
 */
export type ChannelGatewayAdapter = {
  onMessage?(
    handler: (event: {
      chatId: string;
      userId?: string;
      username?: string;
      text: string;
      isDm?: boolean;
      isGroupMention?: boolean;
      messageId?: string;
      attachments?: unknown[];
      raw?: unknown;
    }) => void | Promise<void>,
  ): void;
};

export type ChannelPlugin = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  defaults?: { queue?: { debounceMs?: number } };
  lifecycle?: ChannelLifecycleAdapter;
  outbound?: ChannelOutboundAdapter;
  gateway?: ChannelGatewayAdapter;
  [key: string]: unknown;
};

export type OpenClawPluginChannelRegistration = {
  plugin: ChannelPlugin;
};

// ---------------------------------------------------------------------------
// Hook names (partial — only mappable ones)
// ---------------------------------------------------------------------------

export type OpenClawHookName =
  | 'before_prompt_build'
  | 'agent_end'
  | 'session_start'
  | 'session_end'
  | 'before_tool_call'
  | 'after_tool_call'
  | 'model_call_started'
  | 'model_call_ended'
  | 'message_received'
  | 'message_sending'
  | 'message_sent'
  | 'subagent_spawning'
  | 'subagent_spawned'
  | 'subagent_ended'
  | string; // allow unknown hooks — they warn + no-op

// ---------------------------------------------------------------------------
// Plugin entry — what OpenClaw plugin modules export
// ---------------------------------------------------------------------------

export interface OpenClawPluginEntry {
  id?: string;
  name?: string;
  description?: string;
  configSchema?: unknown;
  kind?: string;
  register(api: OpenClawPluginApiShape): void | Promise<void>;
}

/**
 * Minimal surface of OpenClawPluginApi that we implement in the shim.
 * Named *Shape* (not Impl) so it can be used as the parameter type without
 * creating a circular dependency with api.ts.
 *
 * The shim is wrapped in a Proxy that no-ops unknown method calls, so the
 * interface intentionally omits the index signature — the Proxy handles the
 * ~30 unsupported methods at runtime without TypeScript needing to know.
 */
export interface OpenClawPluginApiShape {
  readonly id: string;
  readonly pluginConfig: Record<string, unknown> | undefined;
  registerMemoryCapability(cap: MemoryPluginCapability): void;
  registerMemoryRuntime(runtime: MemoryPluginRuntime): void;
  registerMemoryPromptSection(builder: MemoryPromptSectionBuilder): void;
  registerMemoryPromptSupplement(builder: MemoryPromptSectionBuilder): void;
  registerMemoryCorpusSupplement(supplement: MemoryCorpusSupplement): void;
  registerMemoryFlushPlan(resolver: MemoryFlushPlanResolver): void;
  registerChannel(reg: OpenClawPluginChannelRegistration | ChannelPlugin): void;
  registerTool(tool: unknown): void;
  on(
    hookName: OpenClawHookName,
    handler: (...args: unknown[]) => unknown,
    opts?: { priority?: number; timeoutMs?: number },
  ): void;
  registerHook(
    events: string | string[],
    handler: (...args: unknown[]) => unknown,
    opts?: { priority?: number },
  ): void;
}
