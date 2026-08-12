import { homedir } from 'node:os';
import { join } from 'node:path';
import { validateUrl } from '@ethosagent/core';
import { noopLogger } from '@ethosagent/logger';
import { buildMcpEnv } from '@ethosagent/safety-scanner';
import { PersonalityScopedSecrets } from '@ethosagent/storage-fs';
import type {
  Logger,
  McpServerInfo,
  SecretsResolver,
  Storage,
  Tool,
  ToolResult,
} from '@ethosagent/types';
import { EthosError } from '@ethosagent/types';

// Re-export wire-contract types lifted into @ethosagent/types so existing
// consumers that imported them from this package keep working.
export type { McpAuthStatus, McpCreatedVia, McpServerInfo, McpTransport } from '@ethosagent/types';

import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { ensureValidToken, loadAccessToken, refreshToken } from './oauth';
import { rewriteDefinitionsToRefs } from './schema-rewrite';
import { probeTokenScopes } from './scope-probe';

export type {
  AttachToPersonalitiesOptions,
  AttachToPersonalitiesResult,
  CompleteOptions,
  CompleteResult,
  InstallFlowStatus,
  McpInstallFlowDeps,
  McpInstallFlowOptions,
  PersonalityUpdater,
  StartOptions,
  StartResult,
} from './install-flow';
export { McpInstallFlow } from './install-flow';
export { McpJsonStore } from './mcp-json-store';
export type {
  CallbackResult,
  DcrAuthorizationResult,
  DcrRequest,
  DcrResponse,
  DiscoveredOAuthMetadata,
  OAuthConfig,
  TokenSet,
} from './oauth';
export {
  buildAuthorizationUrl,
  ConfidentialClientUnsupported,
  DcrUnsupported,
  deleteTokens,
  discoverOAuthMetadata,
  ensureValidToken,
  exchangeCode,
  generateCodeChallenge,
  generateCodeVerifier,
  isTokenExpired,
  loadAccessToken,
  MissingToken,
  OAuthDiscoveryError,
  refreshToken,
  registerOAuthClient,
  revokeToken,
  runDcrAuthorization,
  runPkceLogin,
  startCallbackServer,
  storeTokens,
} from './oauth';
export type { OsvAdvisory, OsvResult } from './osv-check';
export { checkOsvVulnerabilities, clearOsvCache } from './osv-check';
export type { McpPreset } from './presets';
export { getPreset, MCP_PRESETS } from './presets';
export type { McpRemotePreset } from './remote-presets';
export { getRemotePreset, MCP_REMOTE_PRESETS } from './remote-presets';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Keys that buildMcpEnv intentionally pins to the sandbox — config.env cannot override them.
const PINNED_MCP_KEYS = new Set([
  'HOME',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
]);
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface McpServerConfig {
  name: string;
  transport:
    | 'stdio'
    | 'streamable-http'
    | /** @deprecated Use 'streamable-http' for HTTP-based MCP servers. Legacy SSE kept for one release. */ 'sse';
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Env vars to pass through to the subprocess beyond the safe defaults. Credential-pattern vars are still stripped unless explicitly listed here. */
  mcpEnvPassthrough?: string[];
  // sse
  url?: string;
  headers?: Record<string, string>;
  /** Seconds between keepalive pings. Default 30, 0 to disable. */
  keepaliveSeconds?: number;
  /** Timeout in ms for reconnect attempts. Default 10_000. */
  connectTimeoutMs?: number;
  /** Max chars returned from a single MCP tool call. Default 50_000. */
  mcpResultLimitChars?: number;
  /** Auth configuration for servers that require authorization. */
  auth?:
    | {
        type: 'oauth2';
        authorization_endpoint: string;
        token_endpoint: string;
        client_id: string;
        scopes?: string[];
        revocation_endpoint?: string;
        introspection_endpoint?: string;
        dcr?: {
          registration_endpoint: string;
          client_id_issued_at?: number;
          registration_client_uri?: string;
          redirect_uri?: string;
        };
      }
    | { type: 'bearer' };
  created_via?: 'cli' | 'ui';
}

export interface ScopeProbeResult {
  server: string;
  outcome: 'match' | 'mismatch' | 'inactive' | 'no-introspection' | 'error';
  declaredScopes: string[];
  actualScopes: string[];
  error?: string;
}

export interface McpManagerConfig {
  logger?: Logger;
  /** How to handle tool-name collisions across servers. Default: 'warn'. */
  collisionPolicy?: 'warn' | 'error';
  /** Secrets resolver for OAuth token storage. Required for servers with auth config. */
  secrets?: SecretsResolver;
  /** Observability writer for recording scope-probe and other diagnostic events. */
  obs?: {
    recordEvent: (event: {
      category: string;
      severity?: string;
      code?: string;
      details?: Record<string, unknown>;
    }) => void;
  };
  /** Enable OAuth scope introspection probe on connect. Default: false. */
  enableScopeProbe?: boolean;
  /**
   * Called by `addServer` and `removeServer` so the consumer can update its
   * `ToolRegistry`. Boot-time tools are registered by the consumer directly
   * via `getTools()` — the callback only handles deltas. Invoked exactly once
   * per successful add/remove. Not invoked on add failures.
   */
  onToolsChanged?: (added: Tool[], removedNames: string[]) => void;
  /**
   * Base secrets resolver for per-personality scoping. When set,
   * `getToolsForPersonality()` wraps this in `PersonalityScopedSecrets` for
   * OAuth-based servers so each personality gets isolated token storage.
   */
  innerSecrets?: SecretsResolver;
}

// ---------------------------------------------------------------------------
// McpClient — wraps one MCP server connection
// ---------------------------------------------------------------------------

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export class McpClient {
  private _sdk: Client;
  private _config: McpServerConfig;
  private _connected = false;
  private _pending = new Map<symbol, (err: Error) => void>();
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _keepaliveInterval: ReturnType<typeof setInterval> | null = null;
  private _destroyed = false;
  private _transport: { close?: () => Promise<void> | void } | null = null;
  private _generation = 0;
  private _reconnectResolve: (() => void) | null = null;
  private _reconnectPromise: Promise<void> | null = null;
  private _logger: Logger;
  private _secrets?: SecretsResolver;

  /** Callback invoked when the server sends `notifications/tools/list_changed`. */
  onToolsChanged?: (tools: McpToolDef[]) => void;

  /** Callback invoked with scope-probe results (fire-and-forget, gated by config flag). */
  onScopeProbe?: (result: ScopeProbeResult) => void;

  /** Whether to run the OAuth scope introspection probe on connect. */
  enableScopeProbe?: boolean;

  constructor(config: McpServerConfig, opts?: { logger?: Logger; secrets?: SecretsResolver }) {
    if (config.headers) {
      for (const [key, value] of Object.entries(config.headers)) {
        if (key.toLowerCase() === 'authorization' && /^\s*bearer\s/i.test(value)) {
          throw new Error(
            `McpServerConfig.headers must not contain Bearer tokens.\n` +
              `Use auth: { type: 'bearer' } and store the token via:\n` +
              `  echo "<token>" | ethos personality mcp <id> --token-stdin ${config.name}`,
          );
        }
      }
    }
    this._config = config;
    this._sdk = new Client({ name: 'ethos', version: '1.0.0' }, { capabilities: {} });
    this._logger = opts?.logger ?? noopLogger;
    this._secrets = opts?.secrets;
  }

  get name(): string {
    return this._config.name;
  }

  /** Read-only view of the config this client was constructed with. */
  get config(): Readonly<McpServerConfig> {
    return this._config;
  }

  async connect(): Promise<void> {
    const transport = await this._createTransport();
    this._transport = transport as typeof this._transport;

    this._sdk.onclose = () => {
      this._connected = false;
      this._clearKeepalive();
      const err = new Error(`MCP server '${this._config.name}' disconnected`);
      for (const reject of this._pending.values()) reject(err);
      this._pending.clear();
      if (!this._destroyed) this._scheduleReconnect(0);
    };

    await this._sdk.connect(transport);
    this._connected = true;

    // Scope-introspection probe — fire-and-forget, never blocks startup
    if (
      this.enableScopeProbe &&
      this._config.auth?.type === 'oauth2' &&
      this._config.auth.introspection_endpoint &&
      this._secrets
    ) {
      const endpoint = this._config.auth.introspection_endpoint;
      const scopes = this._config.auth.scopes ?? [];
      const secrets = this._secrets;
      const name = this._config.name;
      loadAccessToken(name, secrets)
        .then((token) => {
          if (!token) return;
          probeTokenScopes(name, endpoint, scopes, token, this._logger)
            .then((result) => {
              this.onScopeProbe?.(result);
            })
            .catch(() => {});
        })
        .catch(() => {});
    }

    // Phase 2.3 — dynamic tool discovery via notifications/tools/list_changed
    this._sdk.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        const tools = await this.listTools();
        this.onToolsChanged?.(tools);
      } catch (err) {
        this._logger.warn(
          `[ethos] MCP server '${this._config.name}' tools/list_changed re-fetch failed`,
          {
            component: 'tools-mcp',
            server: this._config.name,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    });

    this._startKeepalive();
  }

  private _startKeepalive(): void {
    const seconds = this._config.keepaliveSeconds ?? 30;
    if (seconds <= 0) return;

    this._keepaliveInterval = setInterval(async () => {
      try {
        await Promise.race([
          this._sdk.ping(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), 5000)),
        ]);
      } catch {
        this._logger.warn(
          `[ethos] MCP server '${this._config.name}' keepalive failed, reconnecting`,
          { component: 'tools-mcp', server: this._config.name },
        );
        this._clearKeepalive();
        this._connected = false;
        try {
          await this._transport?.close?.();
        } catch {
          /* ignore */
        }
        try {
          await this._sdk.close();
        } catch {
          /* ignore */
        }
        this._transport = null;
        if (!this._destroyed) this._scheduleReconnect(0);
      }
    }, seconds * 1000);
  }

  private _clearKeepalive(): void {
    if (this._keepaliveInterval) {
      clearInterval(this._keepaliveInterval);
      this._keepaliveInterval = null;
    }
  }

  protected async _createTransport() {
    if (this._config.transport === 'stdio') {
      const { command } = this._config;
      if (!command)
        throw new Error(`MCP server '${this._config.name}': stdio transport requires 'command'`);
      const safeEnv = buildMcpEnv(this._config.name, this._config.mcpEnvPassthrough);
      // Merge config.env overrides under two constraints:
      //  1. Pinned sandbox dirs (HOME, XDG_*, TMPDIR) can never be overridden.
      //  2. A key must already be present in safeEnv (baseline) OR be explicitly
      //     listed in mcpEnvPassthrough — config.env cannot inject new arbitrary vars.
      const mergedEnv = { ...safeEnv };
      if (this._config.env) {
        const declared = new Set(this._config.mcpEnvPassthrough ?? []);
        for (const [key, value] of Object.entries(this._config.env)) {
          if (PINNED_MCP_KEYS.has(key)) continue;
          if (!(key in safeEnv) && !declared.has(key)) continue;
          mergedEnv[key] = value;
        }
      }
      return new StdioClientTransport({
        command,
        args: this._config.args,
        env: await resolveEnvSecretRefs(this._config.name, mergedEnv, this._secrets),
        stderr: 'pipe',
      });
    }

    if (this._config.transport === 'streamable-http') {
      const { url } = this._config;
      if (!url)
        throw new Error(
          `MCP server '${this._config.name}': streamable-http transport requires 'url'`,
        );
      const headers = { ...this._config.headers };
      if (this._config.auth?.type === 'oauth2' && this._secrets) {
        const token = await ensureValidToken(
          this._config.name,
          this._config.auth,
          this._secrets,
          'ui',
        );
        headers.Authorization = `Bearer ${token}`;
      }
      if (this._config.auth?.type === 'bearer') {
        if (!this._secrets) {
          throw new Error(
            `MCP server '${this._config.name}' requires bearer auth but no secrets resolver is configured.`,
          );
        }
        const token = await this._secrets.get(mcpTokenSecretRef(this._config.name));
        if (!token) {
          throw new Error(
            `MCP server '${this._config.name}' requires a bearer token. Set it via: echo "<token>" | ethos personality mcp <id> --token-stdin ${this._config.name}`,
          );
        }
        headers.Authorization = `Bearer ${token}`;
      }
      // SSRF gate: validate initial URL + disable redirect following so the SDK fetch
      // cannot be redirected to a private/metadata endpoint after passing the initial check.
      // allowLocalhost permits developer-local servers while still blocking cloud metadata.
      validateUrl(url, { allowLocalhost: true });
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      );
      return new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { ...(Object.keys(headers).length > 0 ? { headers } : {}), redirect: 'error' },
      });
    }

    if (this._config.transport === 'sse') {
      const { url } = this._config;
      if (!url) throw new Error(`MCP server '${this._config.name}': sse transport requires 'url'`);
      this._logger.warn(
        `[ethos] MCP '${this._config.name}': SSE transport is deprecated, use 'streamable-http'`,
        { component: 'tools-mcp', server: this._config.name },
      );
      const headers = { ...this._config.headers };
      if (this._config.auth?.type === 'oauth2' && this._secrets) {
        const token = await ensureValidToken(
          this._config.name,
          this._config.auth,
          this._secrets,
          'ui',
        );
        headers.Authorization = `Bearer ${token}`;
      }
      if (this._config.auth?.type === 'bearer') {
        if (!this._secrets) {
          throw new Error(
            `MCP server '${this._config.name}' requires bearer auth but no secrets resolver is configured.`,
          );
        }
        const token = await this._secrets.get(mcpTokenSecretRef(this._config.name));
        if (!token) {
          throw new Error(
            `MCP server '${this._config.name}' requires a bearer token. Set it via: echo "<token>" | ethos personality mcp <id> --token-stdin ${this._config.name}`,
          );
        }
        headers.Authorization = `Bearer ${token}`;
      }
      // SSRF gate: validate initial URL + disable redirect following so the SDK fetch
      // cannot be redirected to a private/metadata endpoint after passing the initial check.
      // allowLocalhost permits developer-local servers while still blocking cloud metadata.
      validateUrl(url, { allowLocalhost: true });
      // Lazy import to avoid pulling in eventsource when not needed
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
      return new SSEClientTransport(new URL(url), {
        requestInit: { ...(Object.keys(headers).length > 0 ? { headers } : {}), redirect: 'error' },
      });
    }

    throw new Error(
      `MCP server '${this._config.name}': unknown transport '${this._config.transport}'`,
    );
  }

  private _scheduleReconnect(attempt: number): void {
    if (this._destroyed || attempt >= 5) return;
    if (!this._reconnectPromise) {
      this._reconnectPromise = new Promise((resolve) => {
        this._reconnectResolve = resolve;
      });
    }
    const delay = Math.min(1000 * 2 ** attempt, 30_000);
    const gen = ++this._generation;
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._destroyed || gen !== this._generation) return;
      this._sdk = new Client({ name: 'ethos', version: '1.0.0' }, { capabilities: {} });
      const timeoutMs = this._config.connectTimeoutMs ?? 10_000;
      try {
        await Promise.race([
          this.connect(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('connect timeout')), timeoutMs),
          ),
        ]);
        if (gen !== this._generation) {
          try {
            await this._sdk.close();
          } catch {
            /* stale */
          }
          return;
        }
        this._reconnectResolve?.();
        this._reconnectPromise = null;
        this._reconnectResolve = null;
      } catch {
        if (gen === this._generation) this._scheduleReconnect(attempt + 1);
      }
    }, delay);
  }

  isConnected(): boolean {
    return this._connected;
  }

  async listTools(): Promise<McpToolDef[]> {
    const result = await this._sdk.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: rewriteDefinitionsToRefs(t.inputSchema as Record<string, unknown>),
    }));
  }

  async callTool(name: string, args: unknown): Promise<ToolResult> {
    return this._callToolInner(name, args, true);
  }

  private async _callToolInner(
    name: string,
    args: unknown,
    allowRetry: boolean,
  ): Promise<ToolResult> {
    if (!this._connected) {
      return {
        ok: false,
        error: `MCP server '${this._config.name}' is not connected`,
        code: 'not_available',
      };
    }

    const key = Symbol();
    const guard = new Promise<never>((_, reject) => {
      this._pending.set(key, reject);
    });

    try {
      const raw = await Promise.race([
        this._sdk.callTool({ name, arguments: args as Record<string, unknown> }),
        guard,
      ]);

      const isError = raw.isError === true;

      // Phase 2.4/2.5 — structuredContent handling (newer MCP spec)
      const structured = (raw as Record<string, unknown>).structuredContent as unknown;
      const content = raw.content as
        | Array<{ type: string; text?: string; data?: string; mimeType?: string }>
        | undefined;

      // Phase 2.5 — merge both when structuredContent (non-sentinel) and content co-exist
      if (structured && structured !== 'no_mcp' && content?.length) {
        const textPart = content
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('\n');
        const json = JSON.stringify(structured, null, 2);
        const merged = textPart ? `${textPart}\n\n--- Structured Data ---\n${json}` : json;
        if (isError) {
          return { ok: false, error: merged || 'Tool returned an error', code: 'execution_failed' };
        }
        return { ok: true, value: merged };
      }

      // Phase 2.4 — structuredContent only (no content or empty content)
      if (structured && structured !== 'no_mcp') {
        const text = JSON.stringify(structured, null, 2);
        if (isError) {
          return { ok: false, error: text || 'Tool returned an error', code: 'execution_failed' };
        }
        return { ok: true, value: text };
      }

      // Phase 2.6 — fall back to content blocks, handling image blocks
      const parts: string[] = [];
      for (const block of content ?? []) {
        if (block.type === 'text') {
          parts.push(block.text ?? '');
        } else if (block.type === 'image') {
          parts.push(
            `[Image: ${block.mimeType ?? 'image/unknown'}, ${block.data?.length ?? 0} bytes base64]`,
          );
        }
      }
      const text = parts.join('\n');

      if (isError) {
        return { ok: false, error: text || 'Tool returned an error', code: 'execution_failed' };
      }
      return { ok: true, value: text || '(no output)' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // OAuth 401 retry — refresh token and reconnect once
      if (
        allowRetry &&
        this._is401Error(msg) &&
        this._config.auth?.type === 'oauth2' &&
        this._secrets
      ) {
        this._logger.warn(
          `[ethos] MCP server '${this._config.name}' returned 401, attempting token refresh`,
          { component: 'tools-mcp', server: this._config.name },
        );
        try {
          await refreshToken(this._config.name, this._config.auth, this._secrets);
          // Reconnect with fresh token
          this._connected = false;
          try {
            await this._transport?.close?.();
          } catch {
            /* ignore */
          }
          this._sdk = new Client({ name: 'ethos', version: '1.0.0' }, { capabilities: {} });
          await this.connect();
          return this._callToolInner(name, args, false);
        } catch {
          // Refresh failed — fall through to error
        }
      }

      // Bearer 401 — no refresh possible, surface actionable message
      if (allowRetry && this._is401Error(msg) && this._config.auth?.type === 'bearer') {
        return {
          ok: false,
          error: `MCP server '${this._config.name}' returned 401. Re-set the token: echo "<token>" | ethos personality mcp <id> --token-stdin ${this._config.name}`,
          code: 'not_available',
        };
      }

      if (allowRetry && this._isConnectionError(msg)) {
        this._logger.warn(`[ethos] MCP server '${this._config.name}' pipe error, retrying once`, {
          component: 'tools-mcp',
          server: this._config.name,
          error: msg,
        });
        this._connected = false;
        if (!this._destroyed) this._scheduleReconnect(0);
        if (this._reconnectPromise) {
          const deadline = this._config.connectTimeoutMs ?? 10_000;
          await Promise.race([this._reconnectPromise, new Promise((r) => setTimeout(r, deadline))]);
        }
        return this._callToolInner(name, args, false);
      }
      return {
        ok: false,
        error: msg,
        code: 'execution_failed',
      };
    } finally {
      this._pending.delete(key);
    }
  }

  private _is401Error(msg: string): boolean {
    return msg.includes('401') || msg.toLowerCase().includes('unauthorized');
  }

  private _isConnectionError(msg: string): boolean {
    const patterns = [
      'EPIPE',
      'ECONNRESET',
      'ECONNREFUSED',
      'connection closed',
      'write after end',
      'socket hang up',
    ];
    const lower = msg.toLowerCase();
    return patterns.some((p) => lower.includes(p.toLowerCase()));
  }

  async disconnect(): Promise<void> {
    this._destroyed = true;
    this._clearKeepalive();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._connected = false;

    // Close the transport
    if (this._transport?.close) {
      try {
        await this._transport.close();
      } catch {
        // Ignore transport close errors
      }
    }

    this._transport = null;

    try {
      await this._sdk.close();
    } catch {
      // Ignore errors on close
    }
  }
}

// ---------------------------------------------------------------------------
// Tool adapter
// ---------------------------------------------------------------------------

function adaptMcpTool(
  mcpTool: McpToolDef,
  serverName: string,
  client: McpClient,
  resultLimitChars?: number,
): Tool {
  return {
    name: `mcp__${serverName}__${mcpTool.name}`,
    description: mcpTool.description ?? mcpTool.name,
    schema: mcpTool.inputSchema,
    toolset: 'mcp',
    outputIsUntrusted: true,
    maxResultChars: resultLimitChars ?? 50_000,
    capabilities: {
      network: { allowedHosts: ['*'] }, // MCP server may access arbitrary hosts
      process: { allowedBinaries: ['*'] },
    },
    isAvailable: () => client.isConnected(),
    execute(args) {
      return client.callTool(mcpTool.name, args);
    },
  };
}

// ---------------------------------------------------------------------------
// McpManager — manages multiple clients
// ---------------------------------------------------------------------------

export class McpManager {
  private _clients: McpClient[];
  /**
   * Per-personality OAuth clients keyed by `${personalityId}::${serverName}`.
   * OAuth/SSE/streamable-http servers get isolated token storage per personality.
   */
  private _oauthClients: Map<string, McpClient> = new Map();
  /**
   * Shared stdio clients keyed by `serverName` alone. Stdio servers have no
   * OAuth tokens, so one connection is reused across all personalities.
   */
  private _stdioClients: Map<string, McpClient> = new Map();
  /**
   * In-flight connection promises keyed by the same keys used for
   * `_oauthClients` and `_stdioClients`. Deduplicates concurrent
   * `getToolsForPersonality()` calls that would otherwise both miss
   * the cache and open duplicate connections.
   */
  private _connectingClients: Map<string, Promise<McpClient | null>> = new Map();
  /**
   * Immutable snapshot. Mutators (`connect`, `addServer`, `removeServer`,
   * and the per-client `tools/list_changed` handler) build a NEW array
   * under the mutex and atomic-swap it. Readers (`getTools`) return the
   * current reference without locking — they see either the pre-swap or
   * post-swap array, never a half-built one.
   */
  private _tools: Tool[] = [];
  private readonly logger: Logger;
  private readonly _collisionPolicy: 'warn' | 'error';
  private readonly _secrets?: SecretsResolver;
  private readonly _innerSecrets?: SecretsResolver;
  private readonly _enableScopeProbe: boolean;
  private readonly _obs?: McpManagerConfig['obs'];
  private readonly _onToolsChanged?: McpManagerConfig['onToolsChanged'];
  /** The original configs passed at construction, needed for lazy per-personality connects. */
  private _configs: McpServerConfig[];
  /** Mutex tail. `addServer` / `removeServer` / `listServers` chain onto this. */
  private _mutationChain: Promise<unknown> = Promise.resolve();

  constructor(configs: McpServerConfig[], opts: McpManagerConfig = {}) {
    this.logger = opts.logger ?? noopLogger;
    this._collisionPolicy = opts.collisionPolicy ?? 'warn';
    this._secrets = opts.secrets;
    this._innerSecrets = opts.innerSecrets;
    this._enableScopeProbe = opts.enableScopeProbe ?? false;
    this._obs = opts.obs;
    this._onToolsChanged = opts.onToolsChanged;
    this._configs = configs;
    this._clients = configs.map((c) => this._buildClient(c));
  }

  /**
   * Construct a client with all construction-time options reapplied: logger,
   * secrets, scope-probe enablement, and observability wiring. Used by both
   * the constructor and `addServer`.
   *
   * `protected` so test subclasses can inject an in-memory transport without
   * a private-field cast — see `extensions/tools-mcp/src/__tests__/mcp-manager-mutability.test.ts`.
   */
  protected _buildClient(config: McpServerConfig): McpClient {
    const client = new McpClient(config, { logger: this.logger, secrets: this._secrets });
    client.enableScopeProbe = this._enableScopeProbe;
    // Phase 2.3 — wire dynamic tool discovery callback. Build an immutable
    // snapshot so concurrent getTools() readers never see a half-built array.
    client.onToolsChanged = (newTools) => {
      const prefix = `mcp__${client.name}__`;
      const next = this._tools.filter((t) => !t.name.startsWith(prefix));
      for (const t of newTools) {
        next.push(adaptMcpTool(t, client.name, client, config.mcpResultLimitChars));
      }
      this._tools = next;
    };
    // Wire scope-probe results to observability
    if (this._obs) {
      const obs = this._obs;
      client.onScopeProbe = (result) => {
        obs.recordEvent({
          category: 'mcp.scope_probe',
          severity: result.outcome === 'match' ? 'info' : 'warn',
          code: result.outcome,
          details: {
            server: result.server,
            declaredScopes: result.declaredScopes,
            actualScopes: result.actualScopes,
            ...(result.error ? { error: result.error } : {}),
          },
        });
      };
    }
    return client;
  }

  /**
   * Build a client with an explicit secrets resolver override. Used by
   * `getToolsForPersonality` to inject personality-scoped secrets for
   * OAuth servers while keeping the same callback wiring as `_buildClient`.
   *
   * `protected` so test subclasses can inject in-memory transports — same
   * rationale as `_buildClient`.
   */
  protected _buildClientWithSecrets(
    config: McpServerConfig,
    secrets: SecretsResolver | undefined,
  ): McpClient {
    const client = new McpClient(config, { logger: this.logger, secrets });
    client.enableScopeProbe = this._enableScopeProbe;
    client.onToolsChanged = (newTools) => {
      const prefix = `mcp__${client.name}__`;
      const next = this._tools.filter((t) => !t.name.startsWith(prefix));
      for (const t of newTools) {
        next.push(adaptMcpTool(t, client.name, client, config.mcpResultLimitChars));
      }
      this._tools = next;
    };
    if (this._obs) {
      const obs = this._obs;
      client.onScopeProbe = (result) => {
        obs.recordEvent({
          category: 'mcp.scope_probe',
          severity: result.outcome === 'match' ? 'info' : 'warn',
          code: result.outcome,
          details: {
            server: result.server,
            declaredScopes: result.declaredScopes,
            actualScopes: result.actualScopes,
            ...(result.error ? { error: result.error } : {}),
          },
        });
      };
    }
    return client;
  }

  /** Whether a transport type needs per-personality OAuth isolation. */
  private _isOAuthTransport(transport: McpServerConfig['transport']): boolean {
    return transport === 'streamable-http' || transport === 'sse';
  }

  /**
   * Lazily connect MCP servers for a specific personality. Stdio servers
   * share one connection across all personalities; OAuth-based servers
   * (streamable-http, SSE) get a per-personality client with scoped token
   * storage.
   *
   * Returns the union of tools from all connected servers.
   */
  async getToolsForPersonality(personalityId: string, serverNames?: string[]): Promise<Tool[]> {
    const tools: Tool[] = [];
    const configs = serverNames
      ? this._configs.filter((c) => serverNames.includes(c.name))
      : this._configs;

    await Promise.allSettled(
      configs.map(async (config) => {
        let client: McpClient;
        if (this._isOAuthTransport(config.transport)) {
          const key = `${personalityId}::${config.name}`;
          const cached = this._oauthClients.get(key);
          if (cached) {
            client = cached;
          } else {
            const inflight = this._connectingClients.get(key);
            if (inflight) {
              const resolved = await inflight;
              if (!resolved) return;
              client = resolved;
            } else {
              const connectPromise = (async (): Promise<McpClient | null> => {
                const scopedSecrets = this._innerSecrets
                  ? new PersonalityScopedSecrets(this._innerSecrets, personalityId)
                  : this._secrets;
                const c = this._buildClientWithSecrets(config, scopedSecrets);
                try {
                  await c.connect();
                  this._oauthClients.set(key, c);
                  return c;
                } catch (err) {
                  this.logger.warn(
                    `[ethos] MCP server '${config.name}' failed to connect for personality '${personalityId}'`,
                    {
                      component: 'tools-mcp',
                      server: config.name,
                      personality: personalityId,
                      error: err instanceof Error ? err.message : String(err),
                    },
                  );
                  return null;
                } finally {
                  this._connectingClients.delete(key);
                }
              })();
              this._connectingClients.set(key, connectPromise);
              const resolved = await connectPromise;
              if (!resolved) return;
              client = resolved;
            }
          }
        } else {
          // stdio — shared across personalities
          const key = `stdio::${config.name}`;
          const cached = this._stdioClients.get(config.name);
          if (cached) {
            client = cached;
          } else {
            const inflight = this._connectingClients.get(key);
            if (inflight) {
              const resolved = await inflight;
              if (!resolved) return;
              client = resolved;
            } else {
              const connectPromise = (async (): Promise<McpClient | null> => {
                const c = this._buildClient(config);
                try {
                  await c.connect();
                  this._stdioClients.set(config.name, c);
                  return c;
                } catch (err) {
                  this.logger.warn(`[ethos] MCP server '${config.name}' failed to connect`, {
                    component: 'tools-mcp',
                    server: config.name,
                    error: err instanceof Error ? err.message : String(err),
                  });
                  return null;
                } finally {
                  this._connectingClients.delete(key);
                }
              })();
              this._connectingClients.set(key, connectPromise);
              const resolved = await connectPromise;
              if (!resolved) return;
              client = resolved;
            }
          }
        }

        try {
          const mcpTools = await client.listTools();
          for (const t of mcpTools) {
            tools.push(adaptMcpTool(t, config.name, client, config.mcpResultLimitChars));
          }
        } catch (err) {
          this.logger.warn(`[ethos] MCP server '${config.name}' listTools failed`, {
            component: 'tools-mcp',
            server: config.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    // Update the immutable tools snapshot so getTools() reflects the latest state.
    this._tools = tools;
    return tools;
  }

  /**
   * Chain `op` onto the mutation mutex. All addServer / removeServer /
   * listServers calls go through this; concurrent invocations serialize in
   * arrival order. The chain is repaired (via `.catch(() => {})`) so one
   * caller's failure does not poison the lane.
   */
  private _serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = this._mutationChain.then(op, op);
    this._mutationChain = next.catch(() => {});
    return next;
  }

  async connect(): Promise<void> {
    const toolsByServer = new Map<string, McpToolDef[]>();
    const pendingTools: Tool[] = [];

    await Promise.allSettled(
      this._clients.map(async (client) => {
        try {
          await client.connect();
        } catch (err) {
          this.logger.warn(`[ethos] MCP server '${client.name}' failed to connect`, {
            component: 'tools-mcp',
            server: client.name,
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }

        try {
          const mcpTools = await client.listTools();
          toolsByServer.set(client.name, mcpTools);
          for (const t of mcpTools) {
            pendingTools.push(
              adaptMcpTool(t, client.name, client, client.config.mcpResultLimitChars),
            );
          }
        } catch (err) {
          this.logger.warn(`[ethos] MCP server '${client.name}' listTools failed`, {
            component: 'tools-mcp',
            server: client.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    try {
      this._detectCollisions(toolsByServer);
    } catch (err) {
      await this.disconnect();
      throw err;
    }
    this._tools = pendingTools;
  }

  private _detectCollisions(toolsByServer: Map<string, McpToolDef[]>): void {
    const nameToServers = new Map<string, string[]>();
    for (const [serverName, tools] of toolsByServer) {
      for (const tool of tools) {
        const existing = nameToServers.get(tool.name);
        if (existing) {
          existing.push(serverName);
        } else {
          nameToServers.set(tool.name, [serverName]);
        }
      }
    }

    for (const [toolName, servers] of nameToServers) {
      if (servers.length < 2) continue;

      const msg = `[ethos] Tool name collision: '${toolName}' exposed by servers: ${servers.join(', ')}`;
      if (this._collisionPolicy === 'error') {
        throw new Error(msg);
      }
      this.logger.warn(msg, {
        component: 'tools-mcp',
        toolName,
        servers,
      });
    }
  }

  getTools(): Tool[] {
    return this._tools;
  }

  async disconnect(): Promise<void> {
    const allClients: McpClient[] = [
      ...this._clients,
      ...this._oauthClients.values(),
      ...this._stdioClients.values(),
    ];
    await Promise.allSettled(allClients.map((c) => c.disconnect()));
    this._oauthClients.clear();
    this._stdioClients.clear();
    this._connectingClients.clear();
  }

  /** Alias for disconnect — intention-revealing name for lifecycle management. */
  async shutdown(): Promise<void> {
    return this.disconnect();
  }

  /**
   * Register a server config without connecting. Used by the install flow
   * for OAuth+personality installs: the token is stored personality-scoped,
   * so `addServer` (which connects with global secrets) would fail with
   * MissingToken. Instead, the flow registers the config here and lets
   * `getToolsForPersonality` handle the lazy connection with personality-
   * scoped secrets.
   */
  registerConfig(config: McpServerConfig): void {
    if (this._configs.some((c) => c.name === config.name)) {
      return; // Already registered (e.g. re-auth path).
    }
    this._configs = [...this._configs, config];
  }

  /**
   * Connect a new MCP server at runtime and surface its tools to the
   * consumer's `ToolRegistry` via the `onToolsChanged` callback.
   *
   * All-or-nothing: if `client.connect()` throws, the manager state is
   * unchanged (no client is appended, no tools are rebuilt, the callback
   * is NOT invoked) and the error propagates to the caller.
   */
  async addServer(config: McpServerConfig): Promise<void> {
    await this._serialize(async () => {
      if (this._clients.some((c) => c.name === config.name)) {
        throw new Error(`MCP server '${config.name}' is already registered`);
      }
      const client = this._buildClient(config);
      let connected = false;
      try {
        await client.connect();
        connected = true;
        const mcpTools = await client.listTools();
        const adapted = mcpTools.map((t) =>
          adaptMcpTool(t, client.name, client, config.mcpResultLimitChars),
        );
        // Atomic swap: build a NEW _tools array and assign in one step. A
        // racing getTools() either sees the old reference or the new one.
        this._tools = [...this._tools, ...adapted];
        this._clients = [...this._clients, client];
        this._configs = [...this._configs, config];
        if (this._onToolsChanged) this._onToolsChanged(adapted, []);
      } catch (err) {
        // Best-effort teardown of any partially-established connection.
        if (connected) {
          try {
            await client.disconnect();
          } catch {
            /* ignore */
          }
        }
        throw err;
      }
    });
  }

  /**
   * Disconnect a server by name and remove its tools from the registry via
   * the `onToolsChanged` callback. Throws `EthosError({ code: 'NOT_FOUND' })`
   * if no server with that name is registered.
   */
  async removeServer(name: string): Promise<void> {
    await this._serialize(async () => {
      const client = this._clients.find((c) => c.name === name);
      if (!client) {
        throw new EthosError({
          code: 'NOT_FOUND',
          cause: `MCP server '${name}' is not registered`,
          action: 'Call listServers() to see registered names',
          details: { name },
        });
      }
      const prefix = `mcp__${name}__`;
      const removedNames = this._tools.filter((t) => t.name.startsWith(prefix)).map((t) => t.name);
      try {
        await client.disconnect();
      } catch {
        // Disconnect failures shouldn't strand the entry; we still remove it
        // so the operator can re-add. The underlying transport is best-effort
        // closed; partial process leaks are surfaced via observability, not
        // this control path.
      }
      this._tools = this._tools.filter((t) => !t.name.startsWith(prefix));
      this._clients = this._clients.filter((c) => c.name !== name);
      this._configs = this._configs.filter((c) => c.name !== name);
      // Also clean up personality-keyed maps for this server name.
      const oauthToRemove: string[] = [];
      for (const [key, c] of this._oauthClients) {
        if (c.name === name) {
          oauthToRemove.push(key);
          try {
            await c.disconnect();
          } catch {
            /* best-effort */
          }
        }
      }
      for (const k of oauthToRemove) this._oauthClients.delete(k);
      const stdioClient = this._stdioClients.get(name);
      if (stdioClient) {
        try {
          await stdioClient.disconnect();
        } catch {
          /* best-effort */
        }
        this._stdioClients.delete(name);
      }
      if (this._onToolsChanged) this._onToolsChanged([], removedNames);
    });
  }

  /**
   * Rename a server and reconnect with the updated config. All internal
   * bookkeeping (tools, clients, maps) is rebuilt atomically.
   */
  async renameServer(oldName: string, newName: string): Promise<void> {
    await this._serialize(async () => {
      const idx = this._configs.findIndex((c) => c.name === oldName);
      if (idx === -1) {
        throw new EthosError({
          code: 'NOT_FOUND',
          cause: `MCP server '${oldName}' is not registered`,
          action: 'Call listServers() to see registered names',
          details: { name: oldName },
        });
      }
      if (this._clients.some((c) => c.name === newName)) {
        throw new Error(`MCP server '${newName}' is already registered`);
      }

      const oldPrefix = `mcp__${oldName}__`;
      const removedNames = this._tools
        .filter((t) => t.name.startsWith(oldPrefix))
        .map((t) => t.name);

      // Disconnect old client
      const oldClient = this._clients.find((c) => c.name === oldName);
      if (oldClient) {
        try {
          await oldClient.disconnect();
        } catch {
          /* best-effort */
        }
      }

      // Build new config with updated name
      const newConfig = { ...this._configs[idx], name: newName };
      this._configs = this._configs.map((c) => (c.name === oldName ? newConfig : c));

      // Build and connect new client
      const newClient = this._buildClient(newConfig);
      let connected = false;
      try {
        await newClient.connect();
        connected = true;
        const mcpTools = await newClient.listTools();
        const adapted = mcpTools.map((t) =>
          adaptMcpTool(t, newName, newClient, newConfig.mcpResultLimitChars),
        );

        this._tools = [...this._tools.filter((t) => !t.name.startsWith(oldPrefix)), ...adapted];
        this._clients = this._clients.map((c) => (c.name === oldName ? newClient : c));

        // Re-key oauth map entries
        for (const [key, c] of this._oauthClients) {
          if (c.name === oldName) {
            this._oauthClients.delete(key);
            const newKey = key.replace(`::${oldName}`, `::${newName}`);
            this._oauthClients.set(newKey, newClient);
          }
        }
        const stdioClient = this._stdioClients.get(oldName);
        if (stdioClient) {
          this._stdioClients.delete(oldName);
          this._stdioClients.set(newName, newClient);
        }

        if (this._onToolsChanged) this._onToolsChanged(adapted, removedNames);
      } catch (err) {
        if (connected) {
          try {
            await newClient.disconnect();
          } catch {
            /* ignore */
          }
        }
        throw err;
      }
    });
  }

  /**
   * Update the stored bearer token for a server and reconnect to pick up
   * the new credentials.
   */
  async updateToken(serverName: string, token: string): Promise<void> {
    await this._serialize(async () => {
      const client = this._clients.find((c) => c.name === serverName);
      if (!client) {
        throw new EthosError({
          code: 'NOT_FOUND',
          cause: `MCP server '${serverName}' is not registered`,
          action: 'Call listServers() to see registered names',
          details: { name: serverName },
        });
      }
      if (!this._secrets) {
        throw new Error('No secrets resolver configured — cannot update token');
      }
      await this._secrets.set(mcpTokenSecretRef(serverName), token);

      // Reconnect to pick up new token
      try {
        await client.disconnect();
      } catch {
        /* best-effort */
      }
      const config = this._configs.find((c) => c.name === serverName);
      if (!config) return;
      const newClient = this._buildClient(config);
      try {
        await newClient.connect();
        const mcpTools = await newClient.listTools();
        const prefix = `mcp__${serverName}__`;
        const adapted = mcpTools.map((t) =>
          adaptMcpTool(t, serverName, newClient, config.mcpResultLimitChars),
        );
        this._tools = [...this._tools.filter((t) => !t.name.startsWith(prefix)), ...adapted];
        this._clients = this._clients.map((c) => (c.name === serverName ? newClient : c));
      } catch {
        // Token updated but reconnect failed — token is stored, will work on next connect
      }
    });
  }

  /**
   * Invalidate cached per-personality OAuth clients for a server after
   * re-auth so the next `getToolsForPersonality` reconnects with the new token.
   */
  invalidatePersonalityClients(serverName: string): void {
    for (const [key, client] of this._oauthClients) {
      if (key.endsWith(`::${serverName}`)) {
        client.disconnect().catch(() => {});
        this._oauthClients.delete(key);
      }
    }
  }

  /**
   * Invalidate the cached per-personality OAuth client for `serverName` and
   * immediately reconnect it with the fresh token. Notifies the tool registry
   * (via `_onToolsChanged`) so the running agent session picks up the new tools
   * without a restart.
   *
   * Safety: if the reconnect fails (no tools returned for this server), the
   * existing tool registrations are left intact — a failed reconnect must not
   * silently de-register working tools.
   */
  async reconnectPersonality(serverName: string, personalityId: string): Promise<void> {
    const prefix = `mcp__${serverName}__`;
    const oldNames = this._tools.filter((t) => t.name.startsWith(prefix)).map((t) => t.name);
    const key = `${personalityId}::${serverName}`;

    // Evict the stale client so getToolsForPersonality creates a fresh one.
    // Keep a reference for rollback in case the reconnect fails.
    const prevClient = this._oauthClients.get(key);
    if (prevClient) {
      this._oauthClients.delete(key);
    }

    // Reconnect with the new token and get the tool list.
    const newTools = await this.getToolsForPersonality(personalityId);
    const added = newTools.filter((t) => t.name.startsWith(prefix));

    if (added.length > 0) {
      // Reconnect succeeded — update the registry and clean up the old client.
      if (this._onToolsChanged) {
        this._onToolsChanged(added, oldNames);
      }
      if (prevClient) {
        prevClient.disconnect().catch(() => {});
      }
    } else {
      // Reconnect returned no tools for this server (connection failed).
      // Restore the previous client so the old tools remain usable; do NOT
      // call _onToolsChanged, which would de-register them.
      if (prevClient && !this._oauthClients.has(key)) {
        this._oauthClients.set(key, prevClient);
      }
      this.logger.warn(
        `[ethos] MCP reconnect returned no tools for '${serverName}' (personality '${personalityId}') — keeping existing connection`,
        { component: 'tools-mcp', server: serverName, personality: personalityId },
      );
    }
  }

  /**
   * Snapshot of the currently-registered servers. Returns a fresh array each
   * call — mutating the returned array does not affect internal state. The
   * `auth_status` field is left unset here; the surface that has token
   * visibility (web-api / CLI) is responsible for filling it in.
   */
  listServers(): McpServerInfo[] {
    return this._clients.map((c) => {
      const cfg = c.config;
      const info: McpServerInfo = { name: cfg.name, transport: cfg.transport };
      if (cfg.command !== undefined) info.command = cfg.command;
      if (cfg.url !== undefined) info.url = cfg.url;
      if (cfg.created_via !== undefined) info.created_via = cfg.created_via;
      return info;
    });
  }
}

// ---------------------------------------------------------------------------
// Glob matching — simple patterns for personality MCP allowlists
// ---------------------------------------------------------------------------

export function matchesGlob(name: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) {
    return name.startsWith(pattern.slice(0, -1));
  }
  return name === pattern;
}

/**
 * `undefined` means "no personality context was supplied" — open mode. An
 * empty array is an explicit empty allowlist and denies everything, mirroring
 * the default-deny MCP gating core already applies (`personality.mcp_servers ??
 * []` in packages/core/src/agent-loop/stages/turn-setup.ts). Without the
 * distinction, a personality with no `mcp_servers` could lease MCP servers
 * through a session view that it cannot reach in a normal turn.
 */
export function isServerAllowed(serverName: string, allowlist: string[] | undefined): boolean {
  if (!allowlist) return true; // open mode — no personality context
  return allowlist.some((pattern) => matchesGlob(serverName, pattern));
}

// ---------------------------------------------------------------------------
// McpSessionView — per-session MCP merging layer (Phase 5)
// ---------------------------------------------------------------------------

export class McpSessionView {
  private readonly _global: McpManager;
  private readonly _sessionClients: McpClient[] = [];
  private readonly _sessionTools: Tool[] = [];

  constructor(globalManager: McpManager) {
    this._global = globalManager;
  }

  /**
   * Connect session-scoped MCP servers, filtering against the personality allowlist.
   * Allowed servers are connected and their tools registered; disallowed ones are rejected.
   */
  async registerSessionServers(
    configs: McpServerConfig[],
    allowlist: string[] | undefined,
    logger?: Logger,
  ): Promise<{ registered: string[]; rejected: { name: string; reason: string }[] }> {
    const registered: string[] = [];
    const rejected: { name: string; reason: string }[] = [];

    for (const config of configs) {
      if (!isServerAllowed(config.name, allowlist)) {
        rejected.push({
          name: config.name,
          reason: `Server '${config.name}' not in personality MCP allowlist`,
        });
        continue;
      }

      const client = new McpClient(config, { logger });
      try {
        await client.connect();
        const mcpTools = await client.listTools();
        for (const t of mcpTools) {
          const tool = adaptMcpTool(t, config.name, client, config.mcpResultLimitChars);
          this._sessionTools.push({ ...tool, mcpSource: 'client' } as Tool);
        }
        this._sessionClients.push(client);
        registered.push(config.name);
      } catch (err) {
        rejected.push({
          name: config.name,
          reason: err instanceof Error ? err.message : String(err),
        });
        // Ensure cleanup on failed connect
        try {
          await client.disconnect();
        } catch {
          /* ignore */
        }
      }
    }

    return { registered, rejected };
  }

  getTools(): Tool[] {
    return [...this._global.getTools(), ...this._sessionTools];
  }

  getSessionTools(): Tool[] {
    return this._sessionTools;
  }

  isSessionTool(toolName: string): boolean {
    return this._sessionTools.some((t) => t.name === toolName);
  }

  async teardown(): Promise<void> {
    await Promise.allSettled(this._sessionClients.map((c) => c.disconnect()));
    this._sessionClients.length = 0;
    this._sessionTools.length = 0;
  }
}
// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

export async function loadMcpConfig(storage: Storage): Promise<McpServerConfig[]> {
  const path = join(homedir(), '.ethos', 'mcp.json');
  const raw = await storage.read(path);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as McpServerConfig[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Secret ref helpers
// ---------------------------------------------------------------------------

export function mcpTokenSecretRef(serverName: string): string {
  return `mcp/${serverName}/access_token`;
}

export function mcpEnvSecretRef(serverName: string, key: string): string {
  return `mcp/${serverName}/env/${key}`;
}

/** Matches a value that is ENTIRELY a `${secrets:ref}` reference. */
const ENV_SECRET_REF_RE = /^\$\{secrets:([^}]+)\}$/;

/**
 * Store each stdio `env` value in the SecretsResolver and return the
 * `${secrets:ref}` map to persist in its place. G-SEC: `mcp.json` may
 * reference a secret by name, never carry its value.
 */
export async function storeEnvSecrets(
  serverName: string,
  env: Record<string, string>,
  secrets: SecretsResolver,
): Promise<Record<string, string>> {
  const refs: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const ref = mcpEnvSecretRef(serverName, key);
    await secrets.set(ref, value);
    refs[key] = `\${secrets:${ref}}`;
  }
  return refs;
}

/**
 * Materialise `${secrets:ref}` env values at spawn time. Values that are not
 * a reference (a literal from an older `mcp.json`, or an inherited process
 * env var) pass through untouched.
 */
export async function resolveEnvSecretRefs(
  serverName: string,
  env: Record<string, string>,
  secrets: SecretsResolver | undefined,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const ref = ENV_SECRET_REF_RE.exec(value)?.[1];
    if (!ref) {
      resolved[key] = value;
      continue;
    }
    if (!secrets) {
      throw new Error(
        `MCP server '${serverName}': env '${key}' references secret '${ref}' but no secrets resolver is configured.`,
      );
    }
    const secret = await secrets.get(ref);
    if (secret === null) {
      throw new Error(
        `MCP server '${serverName}': secret '${ref}' not found. Run 'ethos secrets set ${ref} <value>' to store it.`,
      );
    }
    resolved[key] = secret;
  }
  return resolved;
}

// Re-export schema rewrite helper for external use / testing
export { rewriteDefinitionsToRefs } from './schema-rewrite';
export { probeTokenScopes } from './scope-probe';
