import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve as pathResolve } from 'node:path';
import { AcpServer } from '@ethosagent/acp-server';
import { AgentMesh } from '@ethosagent/agent-mesh';
import { createPersonalityRegistry } from '@ethosagent/personalities';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { createWebApi, WebTokenRepository } from '@ethosagent/web-api';
import { createDangerPredicate } from '@ethosagent/wiring';
import { type EthosConfig, ethosDir } from '../config';
import { createAgentLoop } from '../wiring';
import { hasFlag, parseFlagValue, parsePort } from './serve-helpers';
import { listenWithFallback } from './serve-listen';

// `ethos serve` boots:
//   • Always: ACP server on `--port` (default 3001) + mesh registration
//   • With `--web-experimental`: web UI HTTP+SSE on `--web-port` (default 3000)
//
// Web is opt-in to keep current users' boots unchanged. Flag rename when
// 26.x leaves experimental — for now it matches plan/phases/26-web-ui.md.
//
// Both servers share one `SQLiteSessionStore` so chat from web and from ACP
// land in the same database. SIGINT / SIGTERM cleans up both before exiting.

const ACP_PORT_DEFAULT = 3001;
const WEB_PORT_DEFAULT = 3000;
const WEB_PORT_FALLBACK_ATTEMPTS = 5;

export async function runServe(args: string[], config: EthosConfig): Promise<void> {
  const acpPort = parsePort(parseFlagValue(args, ['--port']), ACP_PORT_DEFAULT);
  const webEnabled = hasFlag(args, ['--web-experimental']);
  const webPort = parsePort(parseFlagValue(args, ['--web-port']), WEB_PORT_DEFAULT);

  const personalityOverride = parseFlagValue(args, ['--personality']);
  if (personalityOverride) config = { ...config, personality: personalityOverride };

  const dir = ethosDir();
  // The web surface owns the `before_tool_call` approval flow, so when
  // --web-experimental is on the loop is built without the synchronous
  // terminal guard and the web-api re-registers a hook against the same
  // registry. ACP shares this loop too — for now both surfaces inherit the
  // web posture when web is enabled (interactive approval over hard block).
  const loopProfile = webEnabled ? 'web' : 'cli';
  const loop = await createAgentLoop(config, { profile: loopProfile });
  const session = new SQLiteSessionStore(join(dir, 'sessions.db'));
  const mesh = new AgentMesh();

  // ACP server (existing behavior — kept first so any breakage is obvious).
  const acpServer = new AcpServer({ runner: loop, session, mesh });
  acpServer.startHttp(acpPort);

  const personalities = await createPersonalityRegistry();
  await personalities.loadFromDirectory(join(dir, 'personalities'));
  const personalityConfig = personalities.get(config.personality ?? 'researcher');
  const capabilities = personalityConfig?.capabilities ?? [];

  const agentId = `${config.personality ?? 'default'}:${process.pid}:${randomUUID().slice(0, 8)}`;
  mesh.register({
    agentId,
    capabilities,
    model: config.model,
    pid: process.pid,
    host: 'localhost',
    port: acpPort,
    activeSessions: 0,
  });
  const stopHeartbeat = mesh.startHeartbeat(agentId, () => acpServer.activeSessionCount);

  console.log(`ethos ACP server listening on http://localhost:${acpPort}`);
  console.log(`  agent:        ${agentId}`);
  console.log(`  personality:  ${config.personality ?? 'default'}`);
  console.log(`  capabilities: ${capabilities.length > 0 ? capabilities.join(', ') : '(none)'}`);
  console.log(`  WebSocket:    ws://localhost:${acpPort}/ws`);

  // Web API (Phase 26). Additive — only mounts when --web-experimental is set.
  let webShutdown: (() => Promise<void>) | null = null;
  if (webEnabled) {
    const webDist = locateWebDist(parseFlagValue(args, ['--web-dist']));
    const webApp = createWebApi({
      dataDir: dir,
      sessionStore: session,
      agentLoop: loop,
      // The same registry the agent loop loaded above is reused so mtime
      // hot-reloads of personality files reach both surfaces in one tick.
      personalities,
      chatDefaults: {
        model: config.model,
        provider: config.provider,
      },
      // Same `checkCommand` rules the CLI guard uses; surfacing them via
      // the approval modal instead of a hard block.
      dangerPredicate: createDangerPredicate(),
      ...(webDist ? { webDist } : {}),
    });
    const tokens = new WebTokenRepository({ dataDir: dir });
    const token = await tokens.getOrCreate();
    const { server, port } = await listenWithFallback(webApp, webPort, WEB_PORT_FALLBACK_ATTEMPTS);
    console.log('');
    console.log(`ethos web UI listening on http://localhost:${port}`);
    console.log(`  open: http://localhost:${port}/auth/exchange?t=${token}`);
    console.log('  (token rotates on first use; cookie remains the steady-state credential)');
    if (webDist) {
      console.log(`  serving SPA from: ${webDist}`);
    } else {
      console.log('  no SPA build found — run `pnpm --filter @ethosagent/web dev` for HMR,');
      console.log('  or `pnpm --filter @ethosagent/web build` to bundle into this server.');
    }
    webShutdown = () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
  }

  const cleanup = async () => {
    stopHeartbeat();
    mesh.unregister(agentId);
    if (webShutdown) await webShutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => void cleanup());
  process.on('SIGINT', () => void cleanup());

  await new Promise(() => {});
}

/**
 * Resolve the absolute path to the built SPA. Search order:
 *   1. `--web-dist <path>` flag (explicit, wins).
 *   2. Sibling to the bundled CLI: `<cliDist>/web/index.html` (the
 *      pre-publish hook that bundles the web app drops it here, per
 *      CEO finding 9.1).
 *   3. Monorepo dev path: `apps/web/dist/index.html` resolved up from
 *      `import.meta.dirname`.
 * Returns null when no candidate exists; the server skips the static
 * mount and prints a hint pointing devs at `pnpm dev:web`.
 */
function locateWebDist(explicit: string | undefined): string | null {
  if (explicit) {
    const abs = pathResolve(explicit);
    return existsSync(join(abs, 'index.html')) ? abs : null;
  }
  const candidates = [
    pathResolve(import.meta.dirname, '..', 'web'),
    pathResolve(import.meta.dirname, '..', '..', '..', '..', 'apps', 'web', 'dist'),
    pathResolve(import.meta.dirname, '..', '..', '..', 'apps', 'web', 'dist'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}
