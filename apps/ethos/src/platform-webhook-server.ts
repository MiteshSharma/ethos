import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Native platform webhook listener — Telegram + Slack
// (plan/phases/telegram-slack-webhook-mode.md §2b, §3c, §4, §7)
//
// A sleep-eligible process cannot hold a long-poll `getUpdates` call or a Socket
// Mode WebSocket open. Both platforms can PUSH over plain inbound HTTP instead;
// this is the door they knock on.
//
// WHY THIS IS A NEW SERVER RATHER THAN A ROUTE ON `webhook-server.ts` (§4):
//
// 1. There is no extension point. `createWebhookServer` matches exactly one
//    route pattern (`WEBHOOK_PATH = /^\/webhook\/([^/]+)$/`) with no router and
//    no way to register another path. Adding platform branches inline would mean
//    hand-rolling a router inside a function never designed to have one.
// 2. THE AUTH MODELS ARE INCOMPATIBLE, NOT LAYERABLE. `webhook-server.ts`'s
//    `authorized()` checks a static bearer secret. Neither platform can send
//    that header — Telegram sends `X-Telegram-Bot-Api-Secret-Token`, Slack sends
//    `X-Slack-Signature` / `X-Slack-Request-Timestamp`. Each platform verifies
//    itself with its own protocol, inside its own handler.
//
//    So: THIS SERVER PERFORMS NO AUTH OF ITS OWN. It routes by path and hands
//    the raw request over. Do not "harden" it later by adding a bearer check —
//    that check would reject every legitimate platform call, and the real
//    verification (grammy's secret-token compare, Bolt's HMAC) is already
//    running one frame deeper, against the right per-bot secret.
// 3. Precedent is a sibling server, not a shared route: `sip-webhook-server.ts`
//    already has its own `createServer` and its own port. This follows it.
//
// THE BODY IS NEVER PRE-PARSED. Slack's HMAC commits to the exact raw bytes and
// Bolt's `HTTPReceiver` reads the stream itself; grammy's `'http'` framework
// adapter likewise concatenates the chunks and `JSON.parse`s them itself.
// `req` is handed over untouched — consuming it here would leave both handlers
// reading an exhausted stream, and re-serializing a parsed body would verify
// something other than what arrived. Verification comes before trust, which
// means before parsing (§4).
//
// PORT: the caller passes one in; the convention is `ETHOS_PLATFORM_WEBHOOK_PORT`
// with default 3006. Extending the map recorded in `commands/gateway.ts`: 3002
// gateway health, 3003 gateway webhook, 3004 is `ethos run-all`'s health
// endpoint (ETHOS_RUNALL_HEALTH_PORT) — and run-all SPAWNS this process — 3005
// is the SIP webhook. The plan's §4/§8/§11 recommend 3004 as "the next open
// slot"; that is superseded, because run-all already holds 3004 and binding it
// here would EADDRINUSE on the most common supervised deployment. 3006 is the
// next free one.
//
// Import surface follows the daemon-free doctrine `sip-webhook-server.ts` and
// `webhook-server.ts` state: node builtins only. `@ethosagent/gateway` is NOT
// imported here and must never be (`daemon-free-smoke.test.ts` enforces it) —
// the adapters carry their own handlers, and the caller hands them in already
// built.
// ---------------------------------------------------------------------------

/**
 * A platform's own request handler: `TelegramAdapter.webhook` (grammy's `'http'`
 * framework adapter) or `SlackAdapter.requestListener` (Bolt's `HTTPReceiver`).
 * Both read the request stream themselves.
 */
export type PlatformWebhookHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

export interface PlatformWebhookServerOptions {
  port: number;
  host: string;
  /**
   * `botKey` → `adapter.webhook`, for every Telegram bot in webhook mode.
   * Mounted at `/telegram/webhook/<botKey>`.
   */
  telegram?: Map<string, PlatformWebhookHandler>;
  /**
   * FULL ROUTE PATH → `adapter.requestListener`, for every Slack app in HTTP
   * mode. Keyed by route rather than botKey because the adapter already hands
   * the path over (`adapter.webhookRoute`, which honours the `webhookPath`
   * override) and because Bolt's `HTTPReceiver` matches its `endpoints` option
   * EXACTLY — keying by botKey would mean recomputing `/slack/events/<botKey>`
   * here, and a mount path that drifts from the receiver's endpoint list 404s
   * silently.
   */
  slack?: Map<string, PlatformWebhookHandler>;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1']);

/** `/telegram/webhook/<botKey>` — see §7 for why the botKey lives in the path. */
const TELEGRAM_PATH = /^\/telegram\/webhook\/([^/]+)$/;

/**
 * Hosts each platform's native webhook route on one `node:http` server.
 *
 * Routing is BY PATH, and that is a security property, not a convenience (§7):
 * a Telegram Update payload carries no "which bot" field at all, and a Slack
 * payload carries `api_app_id` / `team_id` but no botKey — routing on either
 * would mean parsing the body *before* knowing which `signingSecret` or
 * secret-token to verify it against, which inverts verification-before-trust.
 * The URL path selects the adapter — and therefore the secret — before any
 * verification runs. Both platforms let each bot/app register its own distinct
 * URL, so this is how they expect multi-tenant setups to be wired.
 *
 * Anything else — unknown botKey, unknown Slack route, non-POST — is a 404.
 * The maps arrive already built; this file reads no config and constructs no
 * adapters.
 */
export function createPlatformWebhookServer(opts: PlatformWebhookServerOptions): Server {
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = (req.url ?? '').split('?')[0] ?? '';

    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }

    const telegramBotKey = TELEGRAM_PATH.exec(pathname)?.[1];
    const handler = telegramBotKey ? opts.telegram?.get(telegramBotKey) : opts.slack?.get(pathname);

    if (!handler) {
      res.writeHead(404);
      res.end();
      return;
    }

    // `req` goes over untouched — see the header comment on raw bodies.
    //
    // The try/catch is not decoration: Bolt's `HTTPReceiver` THROWS
    // SYNCHRONOUSLY out of `requestListener` when the request path misses its
    // `endpoints` list (HTTPReceiver.js:209, :245). We mount at
    // `adapter.webhookRoute` precisely so that cannot happen, but a mismatch
    // must degrade to a 500 for one request rather than take the listener down
    // and with it every other bot on this server.
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[platform-webhook] handler for ${pathname} failed:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      } else {
        res.end();
      }
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      console.error('[platform-webhook] handler error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    });
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(
        `[platform-webhook] port ${opts.port} in use — Telegram and Slack webhook ` +
          'deliveries will not be received. Set ETHOS_PLATFORM_WEBHOOK_PORT to change.',
      );
    }
  });
  if (!LOOPBACK_HOSTS.has(opts.host)) {
    console.warn(
      `[platform-webhook] bound to non-loopback host ${opts.host} over plaintext HTTP — ` +
        'platform signatures and message content are transmitted in cleartext. Put a ' +
        'TLS-terminating proxy in front, or bind to loopback (ETHOS_SERVE_HOST=127.0.0.1).',
    );
  }
  server.listen(opts.port, opts.host);
  server.unref();
  return server;
}
