import { SessionStreamBuffer } from '@ethosagent/agent-bridge';
import type { AgentLoop } from '@ethosagent/core';
import type { PersonalityRegistry, SessionStore } from '@ethosagent/types';
import type { SseEvent } from '@ethosagent/web-contracts';
import type { Hono } from 'hono';
import { AllowlistRepository } from './repositories/allowlist.repository';
import { ConfigRepository } from './repositories/config.repository';
import { PersonalityRepository } from './repositories/personality.repository';
import { SessionsRepository } from './repositories/sessions.repository';
import { WebTokenRepository } from './repositories/web-token.repository';
import { createRoutes } from './routes';
import { createWebApprovalHook, type DangerPredicate } from './services/approval-hook';
import { ApprovalsService } from './services/approvals.service';
import { type ChatDefaults, ChatService } from './services/chat.service';
import { ConfigService } from './services/config.service';
import { OnboardingService } from './services/onboarding.service';
import { PersonalitiesService } from './services/personalities.service';
import { SessionsService } from './services/sessions.service';

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
   *  reach both surfaces. Boot code typically constructs one and passes it
   *  here AND to `createAgentLoop`'s caller. */
  personalities: PersonalityRegistry;
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
}

export function createWebApi(opts: CreateWebApiOptions): Hono {
  // --- Repositories (data access only) ---
  const tokens = new WebTokenRepository({ dataDir: opts.dataDir });
  const sessionsRepo = new SessionsRepository(opts.sessionStore);
  const personalitiesRepo = new PersonalityRepository({
    registry: opts.personalities,
    userPersonalitiesDir: opts.dataDir,
  });
  const configRepo = new ConfigRepository({ dataDir: opts.dataDir });
  const allowlistRepo = new AllowlistRepository({ dataDir: opts.dataDir });

  // --- Services (business logic) ---
  const sessionsService = new SessionsService({ sessions: sessionsRepo });
  const personalitiesService = new PersonalitiesService({ personalities: personalitiesRepo });
  const configService = new ConfigService({ config: configRepo });
  const onboardingService = new OnboardingService({
    config: configRepo,
    personalities: personalitiesRepo,
  });
  const approvalsService = new ApprovalsService({ allowlist: allowlistRepo });

  // One buffer per process — keyed internally by sessionId. Bridges are
  // owned by ChatService.
  const buffer = new SessionStreamBuffer<SseEvent>();
  const chatService = new ChatService({
    loop: opts.agentLoop,
    sessions: sessionsRepo,
    buffer,
    defaults: opts.chatDefaults,
  });

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

  return createRoutes({
    tokens,
    services: {
      sessions: sessionsService,
      chat: chatService,
      personalities: personalitiesService,
      config: configService,
      onboarding: onboardingService,
      approvals: approvalsService,
    },
    ...(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {}),
    ...(opts.secureCookie !== undefined ? { secureCookie: opts.secureCookie } : {}),
    ...(opts.webDist ? { webDist: opts.webDist } : {}),
  });
}

// Re-exports so boot code can read tokens / inspect contract surfaces directly.
export { WebTokenRepository } from './repositories/web-token.repository';
export type { DangerPredicate, DangerReason } from './services/approval-hook';
export { type ChatDefaults, ChatService } from './services/chat.service';
