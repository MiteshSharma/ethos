import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { csrfMiddleware } from '../middleware/csrf';
import { errorHandler } from '../middleware/error-envelope';
import type { WebTokenRepository } from '../repositories/web-token.repository';
import type { ChatService } from '../services/chat.service';
import type { SessionsService } from '../services/sessions.service';
import { authRoutes } from './auth';
import { openapiRoutes } from './openapi';
import { rpcRoutes } from './rpc';
import { sseRoutes } from './sse';
import { staticRoutes } from './static';

// Single place where all sub-routers attach to a Hono app, with the auth +
// CSRF + error-envelope wiring. `createWebApi` calls this and returns the
// resulting app — boot code (`apps/ethos/src/commands/serve.ts`, future) is
// the only thing that actually `serve()`s it.

export interface CreateRoutesOptions {
  tokens: WebTokenRepository;
  services: ServiceContainer;
  /** Explicit allow-list of origins for cross-origin CSRF check. Empty / unset
   *  means "localhost only". */
  allowedOrigins?: string[];
  /** Set the `secure` flag on the auth cookie. Off by default for localhost. */
  secureCookie?: boolean;
  /** Absolute path to the built `apps/web/dist`. When set, the SPA is
   *  served at `/*` with a fallback to `index.html` for client-side
   *  routes. Omit during dev — Vite's :5173 dev server proxies API calls
   *  to this Hono app instead. */
  webDist?: string;
}

export interface ServiceContainer {
  sessions: SessionsService;
  chat: ChatService;
  personalities: import('../services/personalities.service').PersonalitiesService;
  config: import('../services/config.service').ConfigService;
  onboarding: import('../services/onboarding.service').OnboardingService;
  approvals: import('../services/approvals.service').ApprovalsService;
  cron: import('../services/cron.service').CronService;
  skills: import('../services/skills.service').SkillsService;
  evolver: import('../services/evolver.service').EvolverService;
  mesh: import('../services/mesh.service').MeshService;
  memory: import('../services/memory.service').MemoryService;
  plugins: import('../services/plugins.service').PluginsService;
  platforms: import('../services/platforms.service').PlatformsService;
}

export function createRoutes(opts: CreateRoutesOptions): Hono {
  const app = new Hono();

  // Last-resort error catcher. Routes that throw EthosError land here.
  app.onError(errorHandler);

  // Auth exchange is unauthenticated by definition — it's how cookies get set.
  // Mounted BEFORE the auth middleware below.
  app.route(
    '/auth',
    authRoutes({ tokens: opts.tokens, ...(opts.secureCookie ? { secureCookie: true } : {}) }),
  );

  // Everything below requires the cookie. The OpenAPI surface (browseable
  // docs + REST endpoints derived from the contract) lives here too — same
  // single-user posture, so devs sign in once and the cookie carries.
  app.use('/rpc/*', authMiddleware({ tokens: opts.tokens }));
  app.use('/sse/*', authMiddleware({ tokens: opts.tokens }));
  app.use('/openapi/*', authMiddleware({ tokens: opts.tokens }));

  // Origin / CSRF check on state-changing methods. Localhost-default; pass an
  // explicit list when the server binds beyond localhost.
  const csrf = csrfMiddleware(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {});
  app.use('/rpc/*', csrf);
  app.use('/openapi/*', csrf);

  app.route('/rpc', rpcRoutes({ services: opts.services }));
  app.route('/sse', sseRoutes({ chat: opts.services.chat }));
  app.route('/openapi', openapiRoutes({ services: opts.services }));

  // Static SPA mount (must be LAST — it owns `/*` so any unmatched path
  // falls through to index.html). Skipped when `webDist` isn't supplied;
  // dev users hit Vite at :5173 instead and the API runs without a
  // mounted client.
  if (opts.webDist) {
    app.route('/', staticRoutes({ dist: opts.webDist }));
  }

  return app;
}
