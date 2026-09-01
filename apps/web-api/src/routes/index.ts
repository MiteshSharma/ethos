import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SecretsResolver, Storage } from '@ethosagent/types';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { requestId } from 'hono/request-id';
import type { ChatService } from '../features/chat/service';
import type { SessionsService } from '../features/sessions/service';
import { authMiddleware } from '../middleware/auth';
import { type ApiKeyAuthStore, bearerAuth } from '../middleware/bearer-auth';
import { csrfMiddleware } from '../middleware/csrf';
import { cookieOnlyGuard, dualAuth, resolveScope } from '../middleware/dual-auth';
import { errorHandler } from '../middleware/error-envelope';
import { rateLimitMiddleware } from '../middleware/rate-limit';
import type { WebTokenRepository } from '../repositories/web-token.repository';
import { authRoutes } from './auth';
import { codexAuthRoutes } from './codex-auth';
import { type CronFireTrigger, cronRoutes } from './cron';
import { goalSseRoutes } from './goal-sse';
import { kanbanSseRoutes } from './kanban-sse';
import { openAiRoutes } from './openai';
import { openapiRoutes } from './openapi';
import type { RouteModule } from './route-module';
import { mcpRpcPath, rpcRoutes } from './rpc';
import { setupWhatsAppRoutes } from './setup-whatsapp';
import { sseRoutes } from './sse';
import { staticRoutes } from './static';
import { systemSseRoutes } from './system-sse';

// Single place where all sub-routers attach to a Hono app, with the auth +
// CSRF + error-envelope wiring. `createWebApi` calls this and returns the
// resulting app — boot code (`apps/ethos/src/commands/serve.ts`, future) is
// the only thing that actually `serve()`s it.

export interface CreateRoutesOptions {
  tokens: WebTokenRepository;
  services: ServiceContainer;
  /** Bearer-token store for the OpenAI-compat surface. When omitted, `/v1/*`
   *  is not mounted (deployments without the API need no api_keys table). */
  apiKeys?: ApiKeyAuthStore;
  /** Returns currently registered team names for `/v1/models`. */
  listTeams?: () => Promise<string[]>;
  /** Explicit allow-list of origins for cross-origin CSRF check. Empty / unset
   *  means "localhost only". */
  allowedOrigins?: string[];
  /** Set the `secure` flag on the auth cookie. Off by default for localhost. */
  secureCookie?: boolean;
  /** Honor `X-Forwarded-For` for rate-limit bucketing. Only enable behind a
   *  trusted reverse proxy — otherwise clients spoof the header (WEB-006).
   *  Default false. */
  trustProxy?: boolean;
  /** Absolute path to the built `apps/web/dist`. When set, the SPA is
   *  served at `/*` with a fallback to `index.html` for client-side
   *  routes. Omit during dev — Vite's :5173 dev server proxies API calls
   *  to this Hono app instead. */
  webDist?: string;
  /** Configured public base URL of the web UI — used as an allowlist
   *  anchor when deriving the MCP OAuth redirect URI from inbound
   *  requests. Loopback + RFC 1918 origins are always trusted; anything
   *  else must match this. */
  webBaseUrl?: string;
  /** Storage abstraction for reading ~/.ethos/ files (gateway heartbeat). */
  storage?: Storage;
  /** Secret store — used to persist Codex OAuth tokens from the device-auth flow. */
  secrets: SecretsResolver;
  /** Protocol route modules (A2A, Phase 3) mounted via the explicit, reviewable
   *  seam. Each declares its mount path, auth posture, and description;
   *  `enabled: false` skips it. See {@link RouteModule}. */
  routeModules?: RouteModule[];
  /** SQLite-backed idempotency cache for `/v1/chat/*`. Absent → no
   *  `Idempotency-Key` support (previous behavior). */
  idempotencyStore?: import('../stores/idempotency-store').IdempotencyStore;
  /** Comma-separated CORS origins or `*` for `/v1/*`. Defaults to
   *  `ETHOS_API_CORS_ORIGINS` env var when unset. */
  corsOrigins?: string;
  /** P2-counters (D2/D16) — renders `GET /metrics` (OpenMetrics text, scope
   *  `metrics:read`). Omitted → `/metrics` is not mounted. */
  metricsTextFn?: () => Promise<string>;
  /** P2-counters (D2) — records one `ethos_http_requests_total` increment per
   *  request (method + status), excluding `/healthz`. Omitted → requests are
   *  simply not counted. */
  recordHttpRequest?: (method: string, status: number) => void;
  /** External cron trigger (plan/phases/cron-scheduler-seam.md) — mounts
   *  `POST /cron/fire` (bearer auth, scope `cron`) when present. Boot code
   *  supplies an `HttpFireTrigger` only when `cron.trigger.external` is
   *  `true`; omitted → `/cron/fire` is not mounted. */
  cronFireTrigger?: CronFireTrigger;
}

export interface ServiceContainer {
  sessions: SessionsService;
  chat: ChatService;
  personalities: import('../services/personalities.service').PersonalitiesService;
  config: import('../services/config.service').ConfigService;
  onboarding: import('../services/onboarding.service').OnboardingService;
  approvals: import('../services/approvals.service').ApprovalsService;
  /** Bridge backing the `clarify` tool — undefined when the loop has none. */
  clarifyBridge?: import('@ethosagent/core').ClarifyBridge;
  cron: import('../services/cron.service').CronService;
  skills: import('../services/skills.service').SkillsService;
  evolver: import('../services/evolver.service').EvolverService;
  goals: import('../services/goals.service').GoalsService;
  mesh: import('../services/mesh.service').MeshService;
  memory: import('../services/memory.service').MemoryService;
  plugins: import('../services/plugins.service').PluginsService;
  mcp: import('../services/mcp.service').McpService;
  platforms: import('../services/platforms.service').PlatformsService;
  lab: import('../services/lab.service').LabService;
  kanban: import('../services/kanban.service').KanbanService;
  tasks: import('../services/tasks.service').TasksService;
  completions: import('../features/completions/service').CompletionsService;
  debug: import('../features/debug/service').DebugService;
  apiKeys: import('../services/api-keys.service').ApiKeysService;
  digest: import('../services/digest.service').DigestService;
  /** Browse / delete files under a personality's declared workdir. */
  documents: import('../services/documents.service').DocumentsService;
  namedSecrets: import('../services/named-secrets.service').NamedSecretsService;
  toolSettings: import('../services/tool-settings.service').ToolSettingsService;
  voice?: import('../services/voice.service').VoiceService;
  /** Durable per-conversation voice mode, shared with the gateway's lanes. */
  voiceLaneMode: import('../services/voice-lane-mode.service').VoiceLaneModeService;
  /** Read-only delivery-obligation ledger view. */
  deliveries: import('../services/deliveries.service').DeliveriesService;
  /** Connected wake satellites + the pushed routing table. Absent when this
   *  deployment mounts no satellite lane. */
  satellites?: import('../voice/satellite-registry').SatelliteRegistry;
  /** Read-only telephony call history. Absent when this deployment has no
   *  call log. */
  calls?: import('../services/calls.service').CallsService;
  /** Read / replace the wake-phrase → personality table. */
  wakeRoutes: import('../services/wake-routes.service').WakeRoutesService;
  toolRegistry?: import('@ethosagent/types').ToolRegistry;
  dashboards?: import('@ethosagent/dashboard').DashboardsService;
  pluginLoader?: import('@ethosagent/plugin-loader').PluginLoader;
  agentLoop?: import('@ethosagent/core').AgentLoop;
  systemBus?: import('../services/system-event-bus').SystemEventBus;
  /** A2A peering service — shared with the live `/a2a` handshake (one source of
   *  truth, plan §12). Consumed by the peering RPC procedures (later stage). */
  a2aPeering?: import('@ethosagent/wiring').A2aPeeringService;
  /** Runtime A2A enable/disable control. Consumed by the peering RPC (later
   *  stage) so the Settings toggle flips the same live gate the route modules
   *  and the `a2a_send` tool consult. */
  a2aControl?: import('./route-module').A2aControl;
}

/**
 * WEB-002 CORS origin decision. Returns the origin to reflect (allowing
 * credentialed cross-origin access) or `null` to deny. Only origins the
 * operator explicitly enumerated in `allowedOrigins` are reflected — there is
 * no port-agnostic localhost / `file://` / RFC1918 fallback, so a co-resident
 * localhost origin cannot ride the `ethos_auth` cookie. A missing Origin header
 * (same-origin / non-browser) returns `null`; the browser permits same-origin
 * regardless of CORS.
 */
export function resolveCorsOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): string | null {
  if (!origin) return null;
  return allowedOrigins.includes(origin) ? origin : null;
}

export function createRoutes(opts: CreateRoutesOptions): Hono {
  const app = new Hono();

  // B1 — `x-request-id` on every request/response pair. Registered FIRST,
  // ahead of `/healthz` and every other route, because Hono stops the chain at
  // the first handler that returns a response: a middleware mounted later
  // simply never runs for a route registered earlier, and "echo on every
  // response" has to mean every response.
  //
  // Behaviour comes from Hono's own middleware: an inbound `x-request-id` is
  // respected as-is when it is at most 255 chars of `[A-Za-z0-9_\-=]`, and a
  // UUID is generated otherwise. That character/length filter is load-bearing,
  // not cosmetic — the id is reflected into a response header and an error
  // envelope, so an unvalidated inbound value would be a header-injection
  // vector. Downstream code reads it with `c.get('requestId')`.
  app.use('*', requestId({ headerName: 'x-request-id' }));

  // Unauthenticated health-check for container probes (liveness / readiness).
  // Registered before any auth / CORS middleware so it never requires either.
  // Reads the gateway heartbeat file written by the gateway process to surface
  // adapter health alongside the serve process's own uptime.
  app.get('/healthz', async (c) => {
    const uptime = process.uptime();
    const healthPath = join(homedir(), '.ethos', 'gateway-health.json');

    let gatewayBlock: {
      status: 'ok' | 'down' | 'stale';
      adapters: Array<{ name: string; ok: boolean }>;
      lastHeartbeatAgeSec: number | null;
    };

    try {
      const raw = opts.storage ? await opts.storage.read(healthPath) : null;
      if (!raw) throw new Error('no storage or file missing');
      const hb = JSON.parse(raw) as {
        updatedAt: string;
        adapters: Array<{ name: string; ok: boolean }>;
      };
      const ageSec = (Date.now() - new Date(hb.updatedAt).getTime()) / 1000;
      const stale = !Number.isFinite(ageSec) || ageSec > 30;
      gatewayBlock = {
        status: stale ? 'stale' : 'ok',
        adapters: hb.adapters,
        lastHeartbeatAgeSec: Math.round(ageSec),
      };
    } catch {
      // File missing or unparseable — gateway is not running.
      gatewayBlock = { status: 'down', adapters: [], lastHeartbeatAgeSec: null };
    }

    // An EMPTY adapter list is healthy. A headless deployment with no Slack /
    // Telegram / Discord bot attached is a normal configuration, and `every()`
    // is vacuously true on `[]` — do NOT re-add a `length > 0` guard, it makes
    // every such deployment permanently 503 and reports every restart as a
    // failed start to any supervisor probing this endpoint. What must still
    // fail is a gateway that is absent or stale, which `status === 'ok'` covers.
    const allAdaptersOk = gatewayBlock.adapters.every((a) => a.ok);
    const healthy = gatewayBlock.status === 'ok' && allAdaptersOk;
    const status = healthy ? 'ok' : 'degraded';

    return c.json({ status, uptime, gateway: gatewayBlock }, healthy ? 200 : 503);
  });

  // P2-counters (D2) — ethos_http_requests_total: real tenant traffic
  // (RPC/SSE/OpenAPI/v1/cron), not platform liveness probing. Registered
  // AFTER `/healthz` above, on the same ordering `requestId` at the top of
  // this function documents: `/healthz`'s handler is already terminal by the
  // time this `'*'` middleware is added to the router, so it is never part of
  // that route's composed chain and `/healthz` needs no explicit path check.
  // Optional passthrough, like `metricsTextFn` — omitted when boot code chose
  // not to wire an observability store.
  if (opts.recordHttpRequest) {
    const recordHttpRequest = opts.recordHttpRequest;
    app.use('*', async (c, next) => {
      await next();
      recordHttpRequest(c.req.method, c.res.status);
    });
  }

  // Last-resort error catcher. Routes that throw EthosError land here.
  app.onError(errorHandler);

  // CORS preflight + Access-Control-Allow-Origin headers. The browser needs
  // these BEFORE any RPC/SSE call from a different origin will succeed — the
  // Mission Control template on :3001 calling the API on :3000 is the canonical
  // cross-origin case.
  //
  // WEB-002: because this policy sets `credentials: true`, the browser attaches
  // the `ethos_auth` cookie to reflected cross-origin requests. Reflecting a
  // broad set (any localhost port / `file://` / RFC1918) let ANY co-resident
  // localhost origin — a second dev server, a malicious npx package's local
  // HTTP server — read every RPC response with credentials. We now reflect ONLY
  // the operator-enumerated `allowedOrigins` and FAIL CLOSED when unset.
  //
  // Same-origin requests (the packaged web UI and the desktop app, which loads
  // the SPA from this server) send no `Origin` header, so they never hit this
  // callback and are unaffected. The desktop's remote mode uses bearer auth
  // (an injected `Authorization` header), not cookies, so it does not depend on
  // credentialed CORS reflection either. Cross-origin companion origins must be
  // enumerated explicitly via `allowedOrigins`.
  const corsAllowlist = opts.allowedOrigins ?? [];
  app.use(
    '*',
    cors({
      origin: (origin) => resolveCorsOrigin(origin, corsAllowlist),
      credentials: true,
      allowMethods: ['GET', 'POST', 'OPTIONS', 'DELETE', 'PATCH'],
      allowHeaders: ['Authorization', 'Content-Type'],
    }),
  );

  // Auth exchange is unauthenticated by definition — it's how cookies get set.
  // Mounted BEFORE the auth middleware below.
  app.route(
    '/auth',
    authRoutes({ tokens: opts.tokens, ...(opts.secureCookie ? { secureCookie: true } : {}) }),
  );

  // Codex device auth — unauthenticated (user may not be onboarded yet).
  // The flow is safe to expose: it requires explicit user action in the browser.
  // WEB-007: rate-limit device-code strictly — it spawns background pollers /
  // outbound fetch fan-out. Status is a cheap in-memory lookup the onboarding
  // UI polls repeatedly, so it gets a poll-tolerant limiter (1 token per 4s
  // sustains the UI's polling; short lockout for genuine hammering).
  app.use('/auth/codex/device-code', rateLimitMiddleware({ trustProxy: opts.trustProxy ?? false }));
  app.use(
    '/auth/codex/status',
    rateLimitMiddleware({
      maxTokens: 30,
      refillMs: 4_000,
      lockoutMs: 60_000,
      trustProxy: opts.trustProxy ?? false,
    }),
  );
  app.route('/auth/codex', codexAuthRoutes({ secrets: opts.secrets }));

  // RPC + SSE auth: dual-auth (cookie OR bearer) when an api-key store
  // is wired; cookie-only otherwise (backward-compatible default).
  if (opts.apiKeys) {
    const dual = dualAuth({
      tokens: opts.tokens,
      apiKeys: opts.apiKeys,
      scopeForPath: resolveScope,
    });
    app.use('/rpc/*', dual);
    app.use('/sse/*', dual);
    // apiKeys namespace rejects bearer auth — cookie only.
    app.use('/rpc/apiKeys/*', cookieOnlyGuard());
  } else {
    app.use('/rpc/*', authMiddleware({ tokens: opts.tokens }));
    app.use('/sse/*', authMiddleware({ tokens: opts.tokens }));
  }

  // OpenAPI surface always requires cookie auth (browseable docs).
  app.use('/openapi/*', authMiddleware({ tokens: opts.tokens }));

  // Origin / CSRF check on state-changing methods. Localhost-default; pass an
  // explicit list when the server binds beyond localhost. Skipped for
  // bearer-auth requests — the API key is the auth, not a cookie.
  const csrf = csrfMiddleware(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {});
  app.use('/rpc/*', async (c, next) => {
    if (c.get('authMethod') === 'bearer') return next();
    return csrf(c, next);
  });
  app.use('/openapi/*', csrf);

  // Rate-limit mcp.start to prevent DCR registration spam
  const mcpStartRateLimit = rateLimitMiddleware({ trustProxy: opts.trustProxy ?? false });
  app.use(mcpRpcPath('start'), mcpStartRateLimit);

  // Rate-limit platforms.validate — it fires an outbound live token probe to
  // Telegram/Slack/Discord. Cookie auth alone doesn't stop an authed caller
  // from looping it as an SSRF-adjacent outbound-probe amplifier, so cap it.
  app.use('/rpc/platforms/validate', rateLimitMiddleware({ trustProxy: opts.trustProxy ?? false }));

  app.route(
    '/rpc',
    rpcRoutes({
      services: opts.services,
      ...(opts.webBaseUrl ? { webBaseUrl: opts.webBaseUrl } : {}),
    }),
  );
  app.route('/sse', sseRoutes({ chat: opts.services.chat }));
  app.route('/sse', goalSseRoutes({ goals: opts.services.goals }));
  app.route('/sse', kanbanSseRoutes({ kanban: opts.services.kanban }));
  if (opts.services.systemBus) {
    app.route('/sse', systemSseRoutes({ systemBus: opts.services.systemBus }));
  }
  app.route('/openapi', openapiRoutes({ services: opts.services }));

  // OpenAI-compat surface (F1-F4). Self-contained bearer-token auth — does
  // NOT share the cookie middleware above. Only mounted when an api-key
  // store is wired so test/ACP-only deployments can opt out cleanly.
  if (opts.apiKeys) {
    app.route(
      '/v1',
      openAiRoutes({
        apiKeys: opts.apiKeys,
        personalities: opts.services.personalities,
        completions: opts.services.completions,
        config: opts.services.config,
        ...(opts.services.voice ? { voice: opts.services.voice } : {}),
        ...(opts.listTeams ? { listTeams: opts.listTeams } : {}),
        ...(opts.idempotencyStore ? { idempotencyStore: opts.idempotencyStore } : {}),
        ...(opts.corsOrigins ? { corsOrigins: opts.corsOrigins } : {}),
      }),
    );
  }

  // Prometheus scrape target (P2-counters, D2/D16/D17). Same bearer-auth
  // shape as `/v1/*` above: mounted only when an api-key store is wired, so
  // a deployment without one needs no `metrics:read` key to keep working.
  // `metricsTextFn` is absent when boot code chose not to wire one (tests,
  // deployments with no observability store) — `/metrics` stays unmounted
  // rather than 500ing.
  if (opts.apiKeys && opts.metricsTextFn) {
    const metricsTextFn = opts.metricsTextFn;
    app.get('/metrics', bearerAuth({ store: opts.apiKeys, scope: 'metrics:read' }), async (c) => {
      const text = await metricsTextFn();
      return c.body(text, 200, { 'content-type': 'text/plain; version=0.0.4' });
    });
  }

  // External cron trigger (plan/phases/cron-scheduler-seam.md). Same
  // bearer-auth-gated, presence-mounted shape as `/metrics` above — mounted
  // only when boot code wires an `HttpFireTrigger` (i.e. `cron.trigger.external`
  // is `true`), so a deployment that never opts in needs no `cron`-scoped key.
  if (opts.apiKeys && opts.cronFireTrigger) {
    app.route('/cron', cronRoutes({ apiKeys: opts.apiKeys, trigger: opts.cronFireTrigger }));
  }

  // WhatsApp QR-pairing SSE stream. Gated behind auth — the QR string is
  // a live WhatsApp account-linking credential and must not be publicly
  // accessible. Must be before the static SPA mount (which owns `/*`).
  app.use('/setup/whatsapp/*', authMiddleware({ tokens: opts.tokens }));
  app.route('/setup/whatsapp', setupWhatsAppRoutes());

  // MCP OAuth callback — server-side handler so the popup never needs to load
  // the full SPA. Reads code+state, calls mcp.complete(), returns a tiny HTML
  // page that posts the result to the opener and closes.
  app.get('/oauth/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');
    const errorDescription = c.req.query('error_description');

    // Parse the pending-state cookie (format: `<state>` or `<state>.<personalityId>`)
    const rawCookie = getCookie(c, 'ethos_mcp_pending');
    let pendingState: string | undefined;
    if (rawCookie) {
      const dot = rawCookie.indexOf('.');
      pendingState = dot !== -1 ? rawCookie.slice(0, dot) : rawCookie;
    }

    let msg: Record<string, string | undefined>;

    if (error) {
      const detail = errorDescription ? `${error}: ${errorDescription}` : error;
      msg = { type: 'ethos:mcp_oauth_error', state: state ?? pendingState, code: error, detail };
    } else if (!code || !state) {
      msg = {
        type: 'ethos:mcp_oauth_error',
        state: pendingState,
        code: 'invalid_callback',
        detail: 'Missing code or state parameter',
      };
    } else {
      const result = await opts.services.mcp.complete({ code, state }, pendingState);
      if ('ok' in result && result.ok === false) {
        const r = result as { code: string; detail?: string };
        msg = { type: 'ethos:mcp_oauth_error', state, code: r.code, detail: r.detail };
      } else {
        const r = result as { serverName: string };
        msg = { type: 'ethos:mcp_oauth_success', state, serverName: r.serverName };
      }
    }

    const msgJson = JSON.stringify(msg);
    const html = `<!DOCTYPE html>
<html><head><title>Ethos Auth</title></head><body>
<script>
(function(){
  var msg = ${msgJson};
  // BroadcastChannel — works even when window.opener is null (cross-origin popup)
  try {
    var ch = new BroadcastChannel('ethos:mcp_oauth');
    ch.postMessage(msg);
    ch.close();
  } catch(e) {}
  // Legacy fallback
  if (window.opener) {
    try { window.opener.postMessage(msg, '*'); } catch(e) {}
  }
  // Always close popup (no-op if not a popup)
  setTimeout(function(){ window.close(); }, 1000);
})();
</script>
<p>Authorization complete &mdash; this window will close automatically.</p>
</body></html>`;

    return c.html(html);
  });

  // Route-module seam (plan §12). Protocol modules (A2A, Phase 3) contribute
  // their own Hono sub-router alongside the built-in routes, inheriting the
  // shared CORS + error-envelope middleware registered above. Registration is
  // EXPLICIT (the caller passes the list) and REVIEWABLE (each module declares
  // path + auth + description).
  //
  // Isolation (plan §12 blast-radius mitigation): each module mounts under its
  // OWN basePath with its OWN declared auth posture — a module NEVER shares
  // another route's auth (A2A does not ride `/rpc`'s auth). A per-module
  // `enabled: false` is the kill switch: a disabled module is skipped entirely,
  // so a misbehaving module can be isolated without disturbing the rest of the
  // app. Mounted before the static SPA mount below, which owns `/*`.
  for (const mod of opts.routeModules ?? []) {
    if (mod.enabled === false) continue;
    const wildcard = `${mod.basePath}/*`;
    // Live per-request gate (plan §12 runtime kill switch). When `enabledCheck`
    // is present and returns false, the whole module 404s as if unmounted —
    // without a restart. Registered BEFORE the auth middleware + route so a
    // disabled module never reaches auth or its handler. Scope: a module mounted
    // at '/' owns the app root, so a '/*' gate there would swallow the SPA and
    // every sibling route; the only surface a root-mounted protocol module
    // legitimately claims is the discovery prefix `/.well-known`, so scope the
    // live gate to it (the A2A well-known Agent Card).
    const liveCheck = mod.enabledCheck;
    if (liveCheck) {
      const gateScope = mod.basePath === '/' ? '/.well-known/*' : wildcard;
      app.use(gateScope, async (c, next) => {
        if (!liveCheck()) return c.json({ error: 'DISABLED' }, 404);
        return next();
      });
    }
    if (mod.auth === 'cookie') {
      app.use(wildcard, authMiddleware({ tokens: opts.tokens }));
    } else if (mod.auth === 'bearer') {
      // Mirror `/rpc/*`: dual-auth (cookie OR bearer) when an api-key store is
      // wired; cookie-only otherwise. A bearer module brings the main API's
      // auth posture without re-implementing it.
      app.use(
        wildcard,
        opts.apiKeys
          ? dualAuth({ tokens: opts.tokens, apiKeys: opts.apiKeys, scopeForPath: resolveScope })
          : authMiddleware({ tokens: opts.tokens }),
      );
    }
    // 'public' — no auth middleware; the module owns its own access control.
    app.route(mod.basePath, mod.router);
  }

  // Static SPA mount (must be LAST — it owns `/*` so any unmatched path
  // falls through to index.html). Skipped when `webDist` isn't supplied;
  // dev users hit Vite at :5173 instead and the API runs without a
  // mounted client.
  if (opts.webDist) {
    app.route('/', staticRoutes({ dist: opts.webDist }));
  }

  return app;
}
