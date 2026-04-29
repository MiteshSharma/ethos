import { join } from 'node:path';
import { SessionStreamBuffer } from '@ethosagent/agent-bridge';
import { AgentMesh } from '@ethosagent/agent-mesh';
import type { AgentLoop } from '@ethosagent/core';
import type { CronScheduler } from '@ethosagent/cron';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import type { FilePersonalityRegistry } from '@ethosagent/personalities';
import { SkillsLibrary } from '@ethosagent/skills';
import { FsStorage } from '@ethosagent/storage-fs';
import type { SessionStore, Storage } from '@ethosagent/types';
import type { SseEvent } from '@ethosagent/web-contracts';
import type { Hono } from 'hono';
import { AllowlistRepository } from './repositories/allowlist.repository';
import { ConfigRepository } from './repositories/config.repository';
import { EvolverRepository } from './repositories/evolver.repository';
import { PlatformsRepository } from './repositories/platforms.repository';
import { SessionsRepository } from './repositories/sessions.repository';
import { WebTokenRepository } from './repositories/web-token.repository';
import { createRoutes } from './routes';
import { createWebApprovalHook, type DangerPredicate } from './services/approval-hook';
import { ApprovalsService } from './services/approvals.service';
import { type ChatDefaults, ChatService } from './services/chat.service';
import { ConfigService } from './services/config.service';
import { CronService } from './services/cron.service';
import { EvolverService } from './services/evolver.service';
import { LabService } from './services/lab.service';
import { MemoryService } from './services/memory.service';
import { MeshService } from './services/mesh.service';
import { OnboardingService } from './services/onboarding.service';
import { PersonalitiesService } from './services/personalities.service';
import { PlatformsService } from './services/platforms.service';
import { PluginsService } from './services/plugins.service';
import { SessionsService } from './services/sessions.service';
import { SkillsService } from './services/skills.service';

// Public entry for `@ethosagent/web-api`. Boot code (`apps/ethos/src/commands/
// serve.ts`) builds the dependencies it has lying around — a `SessionStore`,
// the agent loop, the personality registry, the data dir — and hands them to
// `createWebApi`. The package wires the layered service container internally
// and returns a Hono app the boot script can `serve()`.

export interface CreateWebApiOptions {
  /** Where `~/.ethos/web-token` lives (and, transitively, all other state). */
  dataDir: string;
  /** SQLite-backed session store, already initialised. Shared with ACP /
   *  gateway so the same DB rows back every surface. */
  sessionStore: SessionStore;
  /** Agent loop the chat surface drives. Must already be wired with tools,
   *  hooks, providers etc. (typically via `@ethosagent/wiring`). */
  agentLoop: AgentLoop;
  /** Personality registry — shared with the loop so hot-reloads (mtime cache)
   *  reach both surfaces. Must be a `FilePersonalityRegistry` so the web-api's
   *  Personalities tab can drive its CRUD methods (create / update / delete /
   *  duplicate). Construct via `createPersonalityRegistry({ userPersonalitiesDir })`
   *  to enable the writable user directory. */
  personalities: FilePersonalityRegistry;
  /** Provider/model defaults stamped on web-created session rows. */
  chatDefaults: ChatDefaults;
  /** Origins to accept for cross-origin (CSRF) state-changing requests.
   *  Empty / unset = localhost only. */
  allowedOrigins?: string[];
  /** Set `secure` on the auth cookie. Off by default; flip on for non-loopback bind. */
  secureCookie?: boolean;
  /**
   * Decides which tool calls require an explicit user approval. When
   * unset, no approvals are demanded — every tool call passes through
   * (recommended only for tests). Boot code typically passes
   * `createDangerPredicate()` from `@ethosagent/wiring`.
   */
  dangerPredicate?: DangerPredicate;
  /**
   * Absolute path to the built `apps/web/dist` SPA. When set, the same
   * Hono app serves the client at `/*`. Omit in dev — Vite handles
   * static + HMR at :5173 and proxies API calls back here.
   */
  webDist?: string;
  /**
   * CronScheduler instance for the cron tab. Boot code constructs and
   * `start()`s it; the web-api just calls list/create/run/etc. on the
   * shared instance. Omit when cron isn't part of this deployment —
   * `cron.list` returns an empty array gracefully.
   */
  cronScheduler?: CronScheduler;
  /**
   * Storage backend used by services that read ~/.ethos/ directly
   * (currently the MCP-config side of plugins.list). Defaults to FsStorage.
   */
  storage?: Storage;
}

export interface CreateWebApiResult {
  /** Hono app the boot script `serve()`s. */
  app: Hono;
  /**
   * The chat service the API constructed internally. Surface code that
   * needs to push out-of-band SSE events (e.g. the cron worker
   * broadcasting `cron.fired`) reaches in via `chatService.broadcastAll`.
   * Mutating session state here would skip the layered architecture —
   * keep the use to push-event fan-out only.
   */
  chatService: ChatService;
}

export function createWebApi(opts: CreateWebApiOptions): CreateWebApiResult {
  // --- Repositories (data access only) ---
  const tokens = new WebTokenRepository({ dataDir: opts.dataDir });
  const sessionsRepo = new SessionsRepository(opts.sessionStore);
  const configRepo = new ConfigRepository({ dataDir: opts.dataDir });
  const allowlistRepo = new AllowlistRepository({ dataDir: opts.dataDir });
  const skillsLibrary = new SkillsLibrary({ dataDir: opts.dataDir });
  const evolverRepo = new EvolverRepository({ dataDir: opts.dataDir });
  // The mesh registry lives at `<dataDir>/mesh-registry.json`. ACP servers
  // (potentially in other processes) write heartbeats to this file; we
  // just read it via @ethosagent/agent-mesh directly — the wire-format
  // mapping lives in the service.
  const mesh = new AgentMesh(join(opts.dataDir, 'mesh-registry.json'));
  const memoryProvider = new MarkdownFileMemoryProvider({ dir: opts.dataDir });
  const platformsRepo = new PlatformsRepository({ config: configRepo });
  const storage: Storage = opts.storage ?? new FsStorage();

  // --- Services (business logic) ---
  const sessionsService = new SessionsService({ sessions: sessionsRepo });
  const personalitiesService = new PersonalitiesService({
    personalities: opts.personalities,
    library: skillsLibrary,
  });
  const configService = new ConfigService({ config: configRepo });
  const onboardingService = new OnboardingService({
    config: configRepo,
    personalities: opts.personalities,
  });
  const approvalsService = new ApprovalsService({ allowlist: allowlistRepo });
  // Cron service degrades gracefully when no scheduler is provided —
  // tests and ACP-only deployments don't need it. Mutations throw a
  // clear error in that mode; reads return empty.
  const cronService = new CronService({
    scheduler: opts.cronScheduler ?? createPassiveScheduler(),
  });
  const skillsService = new SkillsService({ library: skillsLibrary });
  const evolverService = new EvolverService({ evolver: evolverRepo, library: skillsLibrary });
  const meshService = new MeshService({ mesh });
  const memoryService = new MemoryService({ memory: memoryProvider });
  // Project-level plugins (`<cwd>/.ethos/plugins/`) are out of scope
  // for v1; user-level only is the standard install path. Threading
  // `workingDir` from boot would be the next step when we add it.
  const pluginsService = new PluginsService({ storage, dataDir: opts.dataDir });
  const platformsService = new PlatformsService({ repo: platformsRepo });
  const labService = new LabService({ dataDir: opts.dataDir, loop: opts.agentLoop });

  // One buffer per process — keyed internally by sessionId. Bridges are
  // owned by ChatService. The reap callback lets the bridge map drain
  // alongside the SSE buffer so a long-running server doesn't accumulate
  // an AgentBridge per session forever (memory leak otherwise).
  const buffer = new SessionStreamBuffer<SseEvent>();
  const chatService = new ChatService({
    loop: opts.agentLoop,
    sessions: sessionsRepo,
    buffer,
    defaults: opts.chatDefaults,
    onForget: (sessionId) => approvalsService.cancelForSession(sessionId),
  });
  buffer.onReap = (sessionId) => {
    chatService.forget(sessionId);
  };

  // Bridge approvals → SSE. The hook fires when the agent reaches a
  // dangerous tool call; the resolved event lets every tab on the same
  // session auto-dismiss the modal once any one of them decides.
  approvalsService.onPending((sessionId, request) => {
    chatService.broadcast(sessionId, { type: 'tool.approval_required', request });
  });
  approvalsService.onResolved((sessionId, approvalId, decision, decidedBy) => {
    chatService.broadcast(sessionId, {
      type: 'approval.resolved',
      approvalId,
      decision,
      decidedBy,
    });
  });

  // Register the web `before_tool_call` hook on the loop. CLI/TUI/ACP
  // profiles get the synchronous terminal guard from `@ethosagent/wiring`;
  // the web profile skips that registration so this hook is the sole
  // gatekeeper for dangerous calls. Without a predicate (e.g. tests) every
  // tool call passes through unattended.
  if (opts.dangerPredicate) {
    opts.agentLoop.hooks.registerModifying(
      'before_tool_call',
      createWebApprovalHook({
        approvals: approvalsService,
        isDangerous: opts.dangerPredicate,
      }),
    );
  }

  const app = createRoutes({
    tokens,
    services: {
      sessions: sessionsService,
      chat: chatService,
      personalities: personalitiesService,
      config: configService,
      onboarding: onboardingService,
      approvals: approvalsService,
      cron: cronService,
      skills: skillsService,
      evolver: evolverService,
      mesh: meshService,
      memory: memoryService,
      plugins: pluginsService,
      platforms: platformsService,
      lab: labService,
    },
    ...(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {}),
    ...(opts.secureCookie !== undefined ? { secureCookie: opts.secureCookie } : {}),
    ...(opts.webDist ? { webDist: opts.webDist } : {}),
  });

  return { app, chatService };
}

/**
 * Stand-in for the CronScheduler when no real one is wired (e.g. tests,
 * ACP-only deployments). File-backed reads still work via the
 * scheduler's own `listJobs`/`getJob`; writes/runs throw a clear error
 * so the surface can render an actionable message.
 */
function createPassiveScheduler(): CronScheduler {
  const notConfigured = () => {
    throw new Error('Cron scheduler not configured for this server.');
  };
  return {
    listJobs: async () => [],
    getJob: async () => null,
    createJob: async () => notConfigured(),
    deleteJob: async () => notConfigured(),
    pauseJob: async () => notConfigured(),
    resumeJob: async () => notConfigured(),
    runJobNow: async () => notConfigured(),
    listRuns: async () => [],
    readRunOutput: async () => notConfigured(),
    start: () => {},
    stop: () => {},
  } as unknown as CronScheduler;
}

// Re-exports so boot code can read tokens / inspect contract surfaces directly.
export { WebTokenRepository } from './repositories/web-token.repository';
export type { DangerPredicate, DangerReason } from './services/approval-hook';
export { type ChatDefaults, ChatService } from './services/chat.service';
