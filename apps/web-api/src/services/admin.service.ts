import { EthosError } from '@ethosagent/types';
import type { ConfigService } from './config.service';
import type { ExecutionService } from './execution.service';
import type { PlatformsService } from './platforms.service';
import type { PluginsService } from './plugins.service';

// Admin-panel support logic, kept out of `rpc/admin.ts` so the handlers stay
// thin (layering law: rpc files ≤120 lines). Stateless functions that take
// the services they need — the admin namespace composes services that
// already live on the RpcContext, so a constructed container would be
// redundant wiring.

/**
 * Gate for every admin procedure: `admin.enabled: true` in
 * ~/.ethos/config.yaml — default false; admin access must be enabled
 * explicitly. The rpc interceptor renders FORBIDDEN as HTTP 403.
 */
export async function requireAdmin(config: ConfigService): Promise<void> {
  if (await config.adminEnabled()) return;
  throw new EthosError({
    code: 'FORBIDDEN',
    cause: 'Admin panel is disabled',
    action: 'Set `admin.enabled: true` in ~/.ethos/config.yaml to enable admin access.',
  });
}

export interface AdminStatus {
  channels: Array<{
    id: string;
    platform: string;
    status: 'connected' | 'disconnected' | 'error';
    webhookUrl?: string;
  }>;
  providers: Array<{
    id: string;
    name: string;
    hasKey: boolean;
    healthy?: boolean;
    latencyMs?: number;
  }>;
  mcpServers: Array<{
    name: string;
    status: 'connected' | 'disconnected' | 'error';
    toolCount?: number;
  }>;
  /**
   * The remote execution backend, when this deployment declares one
   * (plan/phases/remote-execution-routing.md §6). Null when it does not — a
   * fresh install has no remote target and must not be told anything failed.
   *
   * `resolved: false` is the boot failure: the backend the posture names could
   * not be constructed, so nothing routed to it will run. Not a reachability
   * answer — resolving opens no connection, and this panel must not spend an
   * ssh round trip per poll. Reachability is `execution.probeSsh`.
   */
  executionBackend: { name: 'ssh'; resolved: boolean; error: string | null } | null;
}

/** Unified status view for the admin page. Each section degrades to empty
 *  when its backing service is unavailable. */
export async function gatherAdminStatus(deps: {
  platforms: PlatformsService;
  config: ConfigService;
  plugins: PluginsService;
  execution: ExecutionService;
}): Promise<AdminStatus> {
  let channels: AdminStatus['channels'] = [];
  try {
    const result = await deps.platforms.list();
    channels = result.platforms.map((p) => ({
      id: p.id,
      platform: p.id,
      status: (p.configured ? 'connected' : 'disconnected') as 'connected' | 'disconnected',
    }));
  } catch {
    // platforms service may not be available
  }

  let providers: AdminStatus['providers'] = [];
  try {
    const cfg = await deps.config.get();
    providers = cfg.providers.map((p) => ({
      id: p.provider,
      name: p.provider,
      hasKey: Boolean(p.apiKeyPreview),
    }));
  } catch {
    // config service may not be available
  }

  let mcpServers: AdminStatus['mcpServers'] = [];
  try {
    const result = await deps.plugins.list();
    mcpServers = result.mcpServers.map((s) => ({
      name: s.name,
      status: (s.auth_status === 'authorized' ? 'connected' : 'disconnected') as
        | 'connected'
        | 'disconnected',
    }));
  } catch {
    // plugins service may not be available
  }

  // Deliberately NOT degraded to null on a throw, unlike the three sections
  // above: `backendHealth` already answers a failure AS a value, so a catch
  // here could only turn a reportable fault into silence.
  const executionBackend = await deps.execution.backendHealth();

  return { channels, providers, mcpServers, executionBackend };
}

/**
 * Admin test-send. web-api has no outbound channel transport — channel
 * adapters live in the gateway process — so this reports that honestly
 * instead of pretending the send happened.
 */
export async function adminTestSend(
  platforms: PlatformsService,
  channel: string,
): Promise<{ ok: boolean; error?: string }> {
  let configured = false;
  try {
    const result = await platforms.list();
    configured = result.platforms.some((p) => p.id === channel && p.configured);
  } catch {
    // platforms service may not be available
  }
  if (!configured) {
    return { ok: false, error: `Channel "${channel}" is not configured.` };
  }
  return {
    ok: false,
    error: 'No channel transport in this deployment — test-send requires the gateway process.',
  };
}
