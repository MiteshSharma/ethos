import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  type InboundSipCall,
  parseInboundSipCall,
  type SipWebhookProvider,
  verifySipWebhook,
} from '@ethosagent/platform-voice';

// ---------------------------------------------------------------------------
// Inbound SIP webhook listener (plan/phases/voice-v4-telephony.md E1)
//
// This is the door a rented phone number knocks on. It is deliberately its own
// tiny listener rather than a route on web-api: eng-review D7 says telephony
// must work with no web-api process running, and a gateway that answers phones
// only when a second daemon happens to be up is not a phone line.
//
// Import surface follows `webhook-server.ts`'s daemon-free doctrine: node
// builtins plus ONE leaf extension (`@ethosagent/platform-voice`, which owns the
// four provider signature schemes and the payload parsers). `@ethosagent/gateway`
// is NOT imported here and must never be — `daemon-free-smoke.test.ts` enforces
// that no top-level feature pulls in the gateway package. Everything that needs
// the running gateway (owner notification, call log, adapter construction)
// arrives through the injected `onCall`.
// ---------------------------------------------------------------------------

export interface SipWebhookServerOptions {
  port: number;
  host: string;
  /** Mount path — `voice.trunk.webhookPath ?? '/sip/inbound'`. */
  path: string;
  provider: SipWebhookProvider;
  /** `voice.trunk.webhookSecret` — the shared secret / public key to verify with. */
  secret: string;
  /**
   * Called with a verified, parsed inbound call. Dispatched DETACHED — the
   * response is already sent — so it must never reject. Rejections are caught
   * and logged here as a backstop, not as a contract.
   */
  onCall: (call: InboundSipCall, raw: unknown) => Promise<void>;
  now?: () => number;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1']);

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * The URL Twilio signed. Twilio's HMAC commits to the PUBLIC url, which a
 * deployment behind a TLS-terminating proxy never sees on the socket — so the
 * proxy's forwarded headers are the only honest source for the scheme and host.
 * The other three schemes ignore this entirely (they sign the body, or the body
 * plus a timestamp), so a wrong guess here can only ever break Twilio.
 */
function requestUrl(req: IncomingMessage, fallbackHost: string): string {
  const header = (name: string): string | undefined => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const proto = header('x-forwarded-proto')?.split(',')[0]?.trim() || 'http';
  const host =
    header('x-forwarded-host')?.split(',')[0]?.trim() || req.headers.host || fallbackHost;
  return `${proto}://${host}${req.url ?? ''}`;
}

/**
 * Body → record, honouring the content type. Twilio posts
 * `application/x-www-form-urlencoded` (`CallSid`/`From`/`To` as form fields),
 * everyone else posts JSON. Parsing the form shape as JSON would make every
 * Twilio call look like a non-call event, which is the quietest possible way to
 * never answer the phone.
 */
function parseBody(rawBody: string, contentType: string | undefined): unknown {
  if (contentType?.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(rawBody));
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

/**
 * Inbound SIP webhook listener. Exposes `POST <path>`: the trunk provider
 * posts a signed call event, the signature is verified over the RAW bytes, and
 * a verified {@link InboundSipCall} is handed to `onCall`.
 *
 * Response codes are chosen for what a trunk provider DOES with them:
 * - **202** — verified call, dispatch running detached. A ringing phone will not
 *   wait for a provider socket to open, so the handler never blocks on `onCall`.
 * - **401** — verification failed. The body is generic; the specific reason goes
 *   to the operator's console only. A 401 that names which of four checks failed
 *   is a probe oracle for whoever found the URL.
 * - **200 `{ ignored: true }`** — verified, but not a call event we can dispatch.
 *   Providers retry non-2xx, and retrying a status callback or a keepalive
 *   forever is worse than acknowledging it once.
 * - **404** — wrong method or path.
 */
export function createSipWebhookServer(opts: SipWebhookServerOptions): Server {
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = (req.url ?? '').split('?')[0];
    if (req.method !== 'POST' || pathname !== opts.path) {
      res.writeHead(404);
      res.end();
      return;
    }

    // The signature covers exactly these bytes. Nothing downstream may
    // re-serialize and verify the result — a round-tripped JSON body is a
    // DIFFERENT string (key order, whitespace, number formatting), so verifying
    // it would either fail every request or, worse, verify something other than
    // what arrived.
    let rawBody: string;
    try {
      rawBody = await readBody(req);
    } catch {
      sendJson(res, 400, { error: 'bad request' });
      return;
    }

    const verified = verifySipWebhook({
      provider: opts.provider,
      secret: opts.secret,
      rawBody,
      headers: req.headers,
      url: requestUrl(req, `${opts.host}:${opts.port}`),
      ...(opts.now ? { now: opts.now } : {}),
    });
    if (!verified.ok) {
      console.warn(`[sip-webhook] rejected inbound request: ${verified.reason}`);
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    const body = parseBody(rawBody, req.headers['content-type']);
    const call = parseInboundSipCall(opts.provider, body);
    if (!call) {
      sendJson(res, 200, { ignored: true });
      return;
    }

    sendJson(res, 202, { accepted: true });
    // `Promise.resolve().then(...)` rather than a bare call: a handler that
    // throws SYNCHRONOUSLY would otherwise escape into the http server's error
    // path with the response already sent.
    void Promise.resolve()
      .then(() => opts.onCall(call, body))
      .catch((err) => {
        console.error('[sip-webhook] inbound call dispatch failed:', err);
      });
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      console.error('[sip-webhook] handler error:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(
        `[sip-webhook] port ${opts.port} in use — inbound calls will not be answered. ` +
          'Set ETHOS_SIP_WEBHOOK_PORT to change.',
      );
    }
  });
  if (!LOOPBACK_HOSTS.has(opts.host)) {
    console.warn(
      `[sip-webhook] bound to non-loopback host ${opts.host} over plaintext HTTP — ` +
        'trunk signatures and call metadata are transmitted in cleartext. Put a ' +
        'TLS-terminating proxy in front, or bind to loopback (ETHOS_SERVE_HOST=127.0.0.1).',
    );
  }
  server.listen(opts.port, opts.host);
  server.unref();
  return server;
}
