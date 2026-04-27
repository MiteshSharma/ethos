import { SessionStreamBuffer } from '@ethosagent/agent-bridge';
import type { AgentLoop } from '@ethosagent/core';
import type { PersonalityRegistry, SessionStore } from '@ethosagent/types';
import type { SseEvent } from '@ethosagent/web-contracts';
import type { Hono } from 'hono';
import { ConfigRepository } from './repositories/config.repository';
import { PersonalityRepository } from './repositories/personality.repository';
import { SessionsRepository } from './repositories/sessions.repository';
import { WebTokenRepository } from './repositories/web-token.repository';
import { createRoutes } from './routes';
import { ChatService, type ChatDefaults } from './services/chat.service';
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

  // --- Services (business logic) ---
  const sessionsService = new SessionsService({ sessions: sessionsRepo });
  const personalitiesService = new PersonalitiesService({ personalities: personalitiesRepo });
  const configService = new ConfigService({ config: configRepo });
  const onboardingService = new OnboardingService({
    config: configRepo,
    personalities: personalitiesRepo,
  });

  // One buffer per process — keyed internally by sessionId. Bridges are
  // owned by ChatService.
  const buffer = new SessionStreamBuffer<SseEvent>();
  const chatService = new ChatService({
    loop: opts.agentLoop,
    sessions: sessionsRepo,
    buffer,
    defaults: opts.chatDefaults,
  });

  return createRoutes({
    tokens,
    services: {
      sessions: sessionsService,
      chat: chatService,
      personalities: personalitiesService,
      config: configService,
      onboarding: onboardingService,
    },
    ...(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {}),
    ...(opts.secureCookie !== undefined ? { secureCookie: opts.secureCookie } : {}),
  });
}

// Re-exports so boot code can read tokens / inspect contract surfaces directly.
export { WebTokenRepository } from './repositories/web-token.repository';
export { ChatService, type ChatDefaults } from './services/chat.service';
