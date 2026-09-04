import { SsrfError, validateUrl } from '@ethosagent/core';
import { PersonalityScopedSecrets } from '@ethosagent/storage-fs';
import {
  ConfidentialClientUnsupported,
  DcrUnsupported,
  deleteTokens,
  MCP_PRESETS,
  MCP_REMOTE_PRESETS,
  McpInstallFlow,
  type McpJsonStore,
  type McpManager,
  type McpServerConfig,
  type OAuthConfig,
  OAuthDiscoveryError,
  type PersonalityUpdater,
  revokeToken,
} from '@ethosagent/tools-mcp';
import type { SecretsResolver } from '@ethosagent/types';

export interface McpServiceOptions {
  mcpManager: McpManager;
  personalityUpdater: PersonalityUpdater;
  secrets: SecretsResolver;
  mcpJsonStore: McpJsonStore;
  redirectUri: string;
}

export class McpService {
  private readonly flow: McpInstallFlow;
  private readonly mcpJsonStore: McpJsonStore;
  private readonly mcpManager: McpManager;
  private readonly personalityUpdater: PersonalityUpdater;
  private readonly secrets: SecretsResolver;

  constructor(opts: McpServiceOptions) {
    this.mcpJsonStore = opts.mcpJsonStore;
    this.mcpManager = opts.mcpManager;
    this.personalityUpdater = opts.personalityUpdater;
    this.secrets = opts.secrets;
    this.flow = new McpInstallFlow({
      mcpManager: opts.mcpManager,
      personalityUpdater: opts.personalityUpdater,
      secrets: opts.secrets,
      mcpJsonStore: opts.mcpJsonStore,
      redirectUri: opts.redirectUri,
    });
  }

  async start(input: { url: string; name?: string; personalityId?: string }, redirectUri?: string) {
    try {
      validateUrl(input.url, { allowLocalhost: true });
    } catch (err) {
      const detail =
        err instanceof SsrfError ? err.message : 'URL points to a private or reserved IP range';
      return { ok: false as const, code: 'ssrf_blocked' as const, detail };
    }

    try {
      // Prefer the per-flow `redirectUri` (derived from the web request's
      // Origin in routes/rpc.ts). When the caller doesn't supply one (e.g.
      // tests, server-to-server, or a request with no Origin and a
      // non-allowlisted host), `flow.start` falls back to the
      // constructor-level default.
      const startOpts: {
        mcpUrl: string;
        name?: string;
        personalityId?: string;
        redirectUri?: string;
      } = { mcpUrl: input.url };
      if (input.personalityId !== undefined) startOpts.personalityId = input.personalityId;
      if (input.name !== undefined) startOpts.name = input.name;
      if (redirectUri !== undefined) startOpts.redirectUri = redirectUri;
      const result = await this.flow.start(startOpts);
      return {
        ok: true as const,
        state: result.state,
        authorizeUrl: result.authorizeUrl,
        serverName: result.serverName,
      };
    } catch (err) {
      if (err instanceof OAuthDiscoveryError) {
        return { ok: false as const, code: 'discovery_failed' as const, detail: err.message };
      }
      if (err instanceof DcrUnsupported) {
        return { ok: false as const, code: 'dcr_unsupported' as const, detail: err.message };
      }
      if (err instanceof ConfidentialClientUnsupported) {
        return { ok: false as const, code: 'dcr_failed' as const, detail: err.message };
      }
      // McpInstallFlow uses EthosError with a stable `kind` discriminator in
      // `details` to indicate which UI error code to surface. Keep this in
      // sync with the discriminators set by install-flow.ts.
      const coded = err as Error & { code?: string; details?: { kind?: string } };
      const kind = coded.details?.kind;
      if (kind === 'name_taken' || coded.code === 'name_taken') {
        return { ok: false as const, code: 'name_taken' as const, detail: coded.message };
      }
      return {
        ok: false as const,
        code: 'discovery_failed' as const,
        detail: coded.message ?? 'Unknown error',
      };
    }
  }

  async complete(input: { code?: string; state: string; error?: string }, cookieState?: string) {
    // CSRF check: the pending cookie must match the state from the input.
    if (!cookieState) {
      return {
        ok: false as const,
        code: 'missing_pending_cookie' as const,
        detail: 'OAuth session expired — please retry from the UI.',
      };
    }
    if (cookieState !== input.state) {
      return {
        ok: false as const,
        code: 'state_mismatch' as const,
        detail: 'OAuth state mismatch — possible CSRF.',
      };
    }

    if (input.error) {
      return { ok: false as const, code: 'upstream_error' as const, detail: input.error };
    }
    if (!input.code) {
      return {
        ok: false as const,
        code: 'code_exchange_failed' as const,
        detail: 'Missing authorization code',
      };
    }
    try {
      const result = await this.flow.complete({ code: input.code, state: input.state });
      return { ok: true as const, serverName: result.serverName };
    } catch (err) {
      const coded = err as Error & { code?: string; details?: { kind?: string } };
      const kind = coded.details?.kind ?? coded.code;
      const code =
        kind === 'expired_state' || kind === 'already_completed'
          ? ('expired_state' as const)
          : ('code_exchange_failed' as const);
      return { ok: false as const, code, detail: coded.message };
    }
  }

  status(cookieState?: string) {
    if (!cookieState) return { status: 'expired' as const };
    return this.getStatus(cookieState);
  }

  getStatus(state: string) {
    return { status: this.flow.getStatus(state) };
  }

  async cancel(state: string) {
    await this.flow.cancel(state);
    return { ok: true as const };
  }

  async attachPersonalities(input: { serverName: string; personalityIds: string[] }) {
    return this.flow.attachToPersonalities(input);
  }

  async list() {
    const configs = await this.mcpJsonStore.read();
    const servers = await Promise.all(
      configs.map(async (c) => {
        const authStatus = await this.computeAuthStatus(c.name, this.secrets, c);
        return {
          name: c.name,
          transport: c.transport as 'stdio' | 'sse' | 'streamable-http',
          command: typeof c.command === 'string' ? c.command : null,
          url: typeof c.url === 'string' ? c.url : null,
          auth_status: authStatus,
          created_via: c.created_via ?? null,
          mcpResultLimitChars: c.mcpResultLimitChars ?? null,
          deprecated: c.transport === 'sse',
        };
      }),
    );
    return { servers };
  }

  async personalityServers(input: { personalityId: string }) {
    const personality = this.personalityUpdater.get(input.personalityId);
    if (!personality) return { servers: [] };
    const mcpServers = personality.mcp_servers ?? [];
    const scopedSecrets = new PersonalityScopedSecrets(this.secrets, input.personalityId);
    const configs = await this.mcpJsonStore.read();

    const servers = await Promise.all(
      mcpServers.map(async (name) => {
        const config = configs.find((c) => c.name === name);
        const raw = await this.computeAuthStatus(name, scopedSecrets, config);
        // Non-OAuth servers are always accessible — map 'none' to 'authorized'.
        const authStatus: 'authorized' | 'expired' | 'missing' =
          raw === 'none' ? 'authorized' : raw;
        return {
          name,
          transport: config?.transport,
          url: typeof config?.url === 'string' ? config.url : undefined,
          auth_status: authStatus,
          auth_type: (config?.auth?.type ?? 'none') as 'oauth2' | 'bearer' | 'none',
        };
      }),
    );

    return { servers };
  }

  async addServer(input: {
    name: string;
    transport: 'streamable-http' | 'sse' | 'stdio';
    url?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    authType?: 'bearer' | 'none';
    token?: string;
    mcpResultLimitChars?: number;
  }) {
    if (input.transport === 'stdio') {
      return {
        ok: false as const,
        code: 'invalid_url' as const,
        detail:
          'Stdio transport cannot be added via the web API. Use the CLI: ethos mcp add <name> --command <cmd> --args <args...> (or --preset <preset>; run `ethos mcp presets` to see them)',
      };
    }

    if (!input.url) {
      return {
        ok: false as const,
        code: 'invalid_url' as const,
        detail: 'URL is required for HTTP transports',
      };
    }
    try {
      validateUrl(input.url, { allowLocalhost: true });
    } catch (err) {
      const detail =
        err instanceof SsrfError ? err.message : 'URL points to a private or reserved IP range';
      return { ok: false as const, code: 'ssrf_blocked' as const, detail };
    }

    const existing = await this.mcpJsonStore.get(input.name);
    if (existing) {
      return {
        ok: false as const,
        code: 'name_taken' as const,
        detail: `Server '${input.name}' already exists`,
      };
    }

    const config: McpServerConfig = {
      name: input.name,
      transport: input.transport,
      url: input.url,
      created_via: 'ui' as const,
      ...(input.token || input.authType === 'bearer' ? { auth: { type: 'bearer' as const } } : {}),
      ...(input.mcpResultLimitChars !== undefined
        ? { mcpResultLimitChars: input.mcpResultLimitChars }
        : {}),
    };
    await this.mcpJsonStore.upsert(input.name, config);

    if (input.token) {
      await this.secrets.set(`mcp/${input.name}/access_token`, input.token);
    }

    return { ok: true as const, serverName: input.name };
  }

  async delete(input: { name: string }) {
    // Read config before removing so we can revoke tokens
    const configs = await this.mcpJsonStore.read();
    const config = configs.find((c) => c.name === input.name);

    // Revoke + delete tokens if the server had OAuth auth
    if (config?.auth?.type === 'oauth2') {
      const oauthConfig: OAuthConfig = {
        authorization_endpoint: config.auth.authorization_endpoint,
        token_endpoint: config.auth.token_endpoint,
        client_id: config.auth.client_id,
        scopes: config.auth.scopes,
        revocation_endpoint: config.auth.revocation_endpoint,
      };
      await revokeToken(input.name, oauthConfig, this.secrets).catch(() => {});
      await deleteTokens(input.name, this.secrets).catch(() => {});
    }

    // Remove from manager
    try {
      await this.mcpManager.removeServer(input.name);
    } catch {
      // Server might not be registered (e.g. stdio server not started)
    }

    // Remove from mcp.json
    await this.mcpJsonStore.remove(input.name);
    return { ok: true as const };
  }

  /**
   * List the tools a given MCP server exposes, for the personality editor's
   * per-server tool checklist. Tool names are returned BARE (the
   * `mcp__<server>__` prefix is stripped) because `mcp.yaml` stores bare
   * names.
   *
   * Discovery runs under `personalityId` because OAuth credentials are
   * scoped per personality. When the server is unreachable (not connected /
   * no credentials), `getToolsForPersonality` swallows the per-server
   * failure and yields no tools — this returns `{ available: false }` so
   * the UI can show a note instead of an empty checklist.
   */
  async serverTools(input: {
    personalityId: string;
    serverName: string;
    limit?: number;
    cursor?: string;
  }) {
    const prefix = `mcp__${input.serverName}__`;
    let all: Awaited<ReturnType<McpManager['getToolsForPersonality']>>;
    try {
      all = await this.mcpManager.getToolsForPersonality(input.personalityId);
    } catch {
      return { available: false as const, tools: [], nextCursor: null };
    }
    const tools = all
      .filter((t) => t.name.startsWith(prefix))
      .map((t) => {
        const bare = t.name.slice(prefix.length);
        return t.description && t.description !== bare
          ? { name: bare, description: t.description }
          : { name: bare };
      });

    const pageSize = input.limit ?? 50;
    const startIdx = input.cursor ? parseInt(input.cursor, 10) : 0;
    const page = tools.slice(startIdx, startIdx + pageSize);
    const nextIdx = startIdx + pageSize;
    const nextCursor = nextIdx < tools.length ? String(nextIdx) : null;

    return { available: tools.length > 0, tools: page, nextCursor };
  }

  async refreshToken(input: { serverName: string }) {
    const configs = await this.mcpJsonStore.read();
    const config = configs.find((c) => c.name === input.serverName);
    const oauth2Auth = config?.auth?.type === 'oauth2' ? config.auth : null;
    if (!oauth2Auth) {
      return { ok: false, expiresAt: null, error: 'Server does not use OAuth2 auth' };
    }
    try {
      const { refreshToken: doRefresh } = await import('@ethosagent/tools-mcp');
      await doRefresh(input.serverName, oauth2Auth, this.secrets);
      const expiresAtStr = await this.secrets
        .get(`mcp/${input.serverName}/expires_at`)
        .catch(() => null);
      return { ok: true, expiresAt: expiresAtStr ?? null };
    } catch (err) {
      return {
        ok: false,
        expiresAt: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async rename(input: { oldName: string; newName: string }) {
    const existing = await this.mcpJsonStore.get(input.newName);
    if (existing) {
      throw new Error(`Server '${input.newName}' already exists`);
    }
    const config = await this.mcpJsonStore.get(input.oldName);
    if (!config) {
      throw new Error(`Server '${input.oldName}' not found`);
    }

    // Migrate secrets before rename so the new name has valid credentials
    const secretKeys = await this.secrets.list(`mcp/${input.oldName}/`);
    for (const key of secretKeys) {
      const value = await this.secrets.get(key);
      if (value) {
        const newKey = key.replace(`mcp/${input.oldName}/`, `mcp/${input.newName}/`);
        await this.secrets.set(newKey, value);
      }
    }

    // Manager rename first — if it fails, secrets are duplicated (harmless) but
    // mcp.json and runtime stay consistent.
    try {
      await this.mcpManager.renameServer(input.oldName, input.newName);
    } catch {
      // Manager may not have this server loaded (e.g. stdio not started).
      // Proceed with persistence — the rename takes effect on next boot.
    }

    // Persist only after manager succeeds (or is inapplicable)
    const newConfig = { ...config, name: input.newName };
    await this.mcpJsonStore.remove(input.oldName);
    await this.mcpJsonStore.upsert(input.newName, newConfig);

    // Clean up old secret keys after successful persistence
    for (const key of secretKeys) {
      await this.secrets.delete(key).catch(() => {});
    }

    return { ok: true as const };
  }

  async updateToken(input: { serverName: string; token: string }) {
    const config = await this.mcpJsonStore.get(input.serverName);
    if (!config) {
      throw new Error(`Server '${input.serverName}' not found`);
    }
    if (config.auth?.type !== 'bearer') {
      throw new Error(`Server '${input.serverName}' does not use bearer auth`);
    }
    await this.secrets.set(`mcp/${input.serverName}/access_token`, input.token);
    try {
      await this.mcpManager.updateToken(input.serverName, input.token);
    } catch {
      // Token stored; reconnect will use it on next attempt
    }
    return { ok: true as const };
  }

  async scopeStatus(input: { serverName: string }) {
    const configs = await this.mcpJsonStore.read();
    const config = configs.find((c) => c.name === input.serverName);
    const oauth2Auth = config?.auth?.type === 'oauth2' ? config.auth : null;
    if (!oauth2Auth) {
      return {
        outcome: 'inactive' as const,
        declaredScopes: [] as string[],
        actualScopes: [] as string[],
      };
    }
    const declaredScopes = oauth2Auth.scopes ?? [];
    return {
      outcome: 'unknown' as const,
      declaredScopes,
      actualScopes: [] as string[],
    };
  }

  /**
   * The curated preset catalog. Static data — no McpManager involvement.
   * Served over oRPC so `apps/web` never imports the Node-only tools-mcp
   * package. Sorted by name so the UI order is stable across calls.
   */
  catalog() {
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    return {
      remote: Object.values(MCP_REMOTE_PRESETS).sort(byName),
      local: Object.values(MCP_PRESETS).sort(byName),
    };
  }

  async validateConfig(input: {
    transport: string;
    url?: string;
    command?: string;
    name?: string;
  }) {
    const errors: { field: string; message: string }[] = [];
    if (input.transport === 'stdio') {
      if (!input.command) {
        errors.push({ field: 'command', message: 'Required for stdio transport' });
      }
    } else {
      if (!input.url) {
        errors.push({ field: 'url', message: 'Required for HTTP transports' });
      } else {
        try {
          new URL(input.url);
        } catch {
          errors.push({ field: 'url', message: 'Must be a valid URL' });
        }
      }
    }
    if (input.name) {
      if (input.name.length > 64) {
        errors.push({ field: 'name', message: 'Max 64 characters' });
      }
      const existingConfig = await this.mcpJsonStore.get(input.name);
      if (existingConfig) {
        errors.push({ field: 'name', message: 'Name already taken' });
      }
    }
    return { valid: errors.length === 0, errors };
  }

  private async computeAuthStatus(
    serverName: string,
    secrets: SecretsResolver,
    config?: { auth?: { type: string } },
  ): Promise<'none' | 'authorized' | 'expired' | 'missing'> {
    if (config?.auth?.type === 'oauth2') {
      const token = await secrets.get(`mcp/${serverName}/access_token`).catch(() => null);
      if (!token) return 'missing';
      const expiresAtStr = await secrets.get(`mcp/${serverName}/expires_at`).catch(() => null);
      if (expiresAtStr) {
        return Date.now() >= Number(expiresAtStr) ? 'expired' : 'authorized';
      }
      return 'authorized';
    }
    if (config?.auth?.type === 'bearer') {
      const token = await secrets.get(`mcp/${serverName}/access_token`).catch(() => null);
      return token ? 'authorized' : 'missing';
    }
    return 'none';
  }

  async reconnect(input: { name: string; personalityId?: string }) {
    const configs = await this.mcpJsonStore.read();
    const existing = configs.find((c) => c.name === input.name);
    if (!existing?.url) {
      return {
        ok: false as const,
        code: 'discovery_failed' as const,
        detail: `Server '${input.name}' not found or has no URL`,
      };
    }
    const startInput: { url: string; name: string; personalityId?: string } = {
      url: existing.url,
      name: input.name,
    };
    if (input.personalityId !== undefined) startInput.personalityId = input.personalityId;
    return this.start(startInput);
  }
}
