import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { z } from 'zod';

/** Only `prompt` / `text` are consumed; identity is server-derived from the
 *  authenticated hookId, never the body. Unknown keys are ignored. */
const WebhookBody = z.object({
  prompt: z.string().optional(),
  text: z.string().optional(),
});

export interface WebhookConfig {
  personalityId: string;
  secret: string;
  sessionKey?: string;
  /** Prefilter script file (scripts-dir relative, .sh/.py) run with the raw
   *  request body on stdin before any turn is dispatched. Exit 0 → stdout
   *  replaces the prompt — or, in `deliverOnly` mode, the DELIVERED CONTENT,
   *  since that mode has no prompt at all (empty stdout keeps the
   *  body-derived value in both modes); exit 78 → request filtered, no turn;
   *  anything else → 500, no turn. */
  prefilter?: string;
  /** Wall-clock limit for the prefilter in seconds. Default 30, max 600. */
  prefilterTimeoutSeconds?: number;
  /** 'sync' (default) holds the connection for the agent's reply;
   *  'ack' responds 202 immediately and runs the turn detached. */
  mode?: 'sync' | 'ack';
  /** Accepted event names. Absent or empty accepts every request — today's
   *  behavior, unchanged. When set, a request whose event name is not listed
   *  is answered 200 `{ filtered: true, reason: 'event' }` with no turn. */
  events?: string[];
  /** Request header carrying the event name. Default `'x-event-type'`.
   *  Only meaningful alongside `events`. */
  eventHeader?: string;
  /** Dotted path into the parsed JSON body holding the event name, used when
   *  the header is absent. Default `'event'`; e.g. `'meta.event'`. Only
   *  meaningful alongside `events`. */
  eventField?: string;
  /** Relay the content and NEVER dispatch a turn. The model is not involved,
   *  so the `prompt`/`text` body requirement does not apply either — a raw,
   *  non-JSON payload is a legitimate request in this mode. Requires at least
   *  one `deliver` target (enforced at config-parse time). Orthogonal to
   *  `mode`: with no turn dispatched, there is nothing for sync/ack to mean. */
  deliverOnly?: boolean;
  /** Extra destinations for this hook's content, fanned out alongside (never
   *  instead of) the HTTP response. On an agent-triggered hook they receive the
   *  agent's reply — which is what finally gives `mode: 'ack'` somewhere to put
   *  it. Absent or empty → no fan-out, today's behavior exactly. */
  deliver?: WebhookDeliveryTarget[];
  /** Payload-integrity signing, ADDITIVE to the bearer `secret` and never a
   *  replacement for it. The two check different things — the signature proves
   *  the body arrived unmodified, the bearer proves who the caller is — so when
   *  `hmac` is configured BOTH must pass. `secret` stays mandatory regardless.
   *  Absent → identical to today. */
  hmac?: WebhookHmacConfig;
  /** Per-hook request throttle. Absent → unlimited, today's behavior exactly
   *  (the bucket path never runs). The limiter is IN-PROCESS and keyed by
   *  hookId — never shared or distributed. The gateway is a single-process
   *  model, so a distributed limiter would solve a problem this deployment
   *  shape does not have; a second process would be a second gateway, which is
   *  not a supported deployment. */
  rateLimit?: WebhookRateLimitConfig;
}

/** Throttle settings for one hook (`webhooks.<id>.rateLimit.*`). */
export interface WebhookRateLimitConfig {
  /** Requests allowed per minute. */
  maxPerMinute?: number;
  /** Lockout applied once the bucket empties. Default 600 (10 minutes). */
  lockoutSeconds?: number;
}

/** Reason a request was rejected, for the observability sink. */
export type WebhookRejectionReason =
  | 'unknown_hook'
  | 'unauthorized'
  | 'invalid_signature'
  | 'rate_limited'
  | 'unclassifiable_event'
  | 'prefilter_failed';

/** Injected by the gateway command — receives every rejection so an operator
 *  can see refused traffic without tailing the log. Must never be able to
 *  break a request: the server wraps each call. */
export type WebhookRejectionSink = (hookId: string, reason: WebhookRejectionReason) => void;

/** HMAC verification settings for one hook (`webhooks.<id>.hmac.*`). */
export interface WebhookHmacConfig {
  /** Shared signing secret. */
  secret: string;
  /** Header carrying the signature. Default `'x-signature'`. The value must be
   *  the bare lowercase hex digest — a sender that emits a prefixed form such
   *  as `sha256=<hex>` needs a prefilter or a plain-hex signature; no prefix
   *  stripping happens here. */
  header?: string;
  /** Hash algorithm. Default `'sha256'`. */
  algorithm?: string;
  /** Previous secret, accepted during a rotation window so an operator can
   *  update the sender without a synchronized cutover. */
  previousSecret?: string;
}

/** One delivery destination. Structurally matches `DeliveryTargetConfig` from
 *  `@ethosagent/gateway` — redeclared locally so this file keeps its
 *  types-only import surface (see `WebhookGateway` doctrine note below), the
 *  same way `PrefilterOutcome` mirrors `@ethosagent/cron`'s
 *  `ScriptRunOutcome`. The gateway command adapts between the two at the
 *  wiring boundary. */
export type WebhookDeliveryTarget =
  | { type: 'log' }
  | { type: 'platform'; adapterId: string; chatId: string; threadId?: string };

/** Injected by the gateway command (which owns the concrete
 *  `@ethosagent/gateway` import) — fans `content` out to `targets`, resolving
 *  adapters and recording delivery obligations. Never rejects; one entry per
 *  target, positionally matching the input. */
export type DeliveryRelay = (
  targets: readonly WebhookDeliveryTarget[],
  content: string,
  ctx: { hookId: string; sessionKey: string },
) => Promise<Array<{ ok: boolean; error?: string }>>;

/** Outcome of a prefilter script run. Structurally matches `ScriptRunOutcome`
 *  from `@ethosagent/cron` — redeclared locally so this file keeps its
 *  types-only import surface (see `WebhookGateway` doctrine note below). */
export interface PrefilterOutcome {
  /** True when the script ran to completion (any exit code). False on
   *  timeout, spawn failure, or a missing/invalid script file. */
  ok: boolean;
  exitCode: number | null;
  /** Script stdout — the runner secret-redacts it before returning. */
  stdout: string;
  /** Human-readable reason, set only when ok === false. */
  failure?: string;
}

/** Injected by the gateway command (which owns the concrete
 *  `@ethosagent/cron` import) — runs a scripts-dir script with the raw
 *  request body on stdin, applying the shared path guards + redaction. */
export type PrefilterRunner = (
  file: string,
  opts: { stdin: string; timeoutSeconds: number },
) => Promise<PrefilterOutcome>;

/** Matches PRECHECK_SKIP_EXIT_CODE in `@ethosagent/cron` (not importable
 *  here — types-only import surface). */
const PREFILTER_FILTERED_EXIT_CODE = 78;
const DEFAULT_PREFILTER_TIMEOUT_SECONDS = 30;

const DEFAULT_EVENT_HEADER = 'x-event-type';
const DEFAULT_EVENT_FIELD = 'event';

/** Dotted-path read over plain objects — `'meta.event'` walks `meta` then
 *  `event`. Returns undefined at the first segment that is not a key on a
 *  plain object, so arrays and primitives simply yield nothing. */
function lookupPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Node lowercases inbound header names, and a repeated header arrives as an
 *  array — take the first value in that case. */
function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : undefined;
}

/**
 * Minimal slice of the Gateway this server drives. Kept local — and the
 * capturing-adapter factory is injected — so this file imports only
 * `@ethosagent/types`. That keeps the `@ethosagent/gateway` import confined to
 * `commands/gateway.ts` (the daemon-free doctrine, `daemon-free-smoke.test.ts`):
 * no top-level feature may pull in the gateway package.
 */
export interface WebhookGateway {
  handleMessage(message: InboundMessage, adapter: PlatformAdapter): Promise<void>;
}

/** Per-request response-capturing adapter — supplied by the gateway command,
 *  which owns the only `@ethosagent/gateway` import. */
export type CaptureFactory = () => { adapter: PlatformAdapter; getReply(): string };

// Module-level counter so repeated requests get distinct messageIds and the
// gateway's inbound dedup never drops a legitimate repeated call.
let requestCounter = 0;

const WEBHOOK_PATH = /^\/webhook\/([^/]+)$/;

function sendJson(
  res: ServerResponse,
  code: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(code, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(body));
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
  lockedUntil: number;
}

const RATE_LIMIT_REFILL_MS = 60_000;
const DEFAULT_RATE_LIMIT_LOCKOUT_SECONDS = 600;

/**
 * Consume one token from a hook's bucket.
 *
 * A local port of the refill-by-elapsed-time + lockout algorithm in
 * `apps/web-api/src/middleware/rate-limit.ts` — deliberately reimplemented
 * rather than imported, because that one is Hono middleware and this server is
 * raw `node:http`, so there is nothing pluggable to reuse. ~30 lines is a
 * cheaper price than an abstraction spanning two unrelated server shapes; the
 * two must stay behaviorally identical, so change them together.
 *
 * Returns the `Retry-After` seconds when the request must be refused, or
 * undefined when it may proceed (a token having been spent).
 */
function consumeRateLimitToken(
  buckets: Map<string, TokenBucket>,
  hookId: string,
  maxTokens: number,
  lockoutMs: number,
  now: number,
): number | undefined {
  let bucket = buckets.get(hookId);
  if (!bucket) {
    bucket = { tokens: maxTokens, lastRefill: now, lockedUntil: 0 };
    buckets.set(hookId, bucket);
  }
  // Lockout is checked first: while it holds, nothing refills and nothing is
  // spent — an emptied bucket stays empty for the whole penalty window.
  if (now < bucket.lockedUntil) return Math.ceil((bucket.lockedUntil - now) / 1000);
  const elapsed = now - bucket.lastRefill;
  if (elapsed >= RATE_LIMIT_REFILL_MS) {
    const refills = Math.floor(elapsed / RATE_LIMIT_REFILL_MS);
    bucket.tokens = Math.min(maxTokens, bucket.tokens + refills);
    bucket.lastRefill = now;
  }
  if (bucket.tokens <= 0) {
    bucket.lockedUntil = now + lockoutMs;
    return Math.ceil(lockoutMs / 1000);
  }
  bucket.tokens -= 1;
  return undefined;
}

/**
 * Sanitize a hookId that came from the request URL for logging.
 *
 * Every OTHER hookId in this file is a config key — trusted. The one on the
 * unknown-hook path is whatever an anonymous caller put in the path, and it
 * reaches both a log line and an observability row, so it is stripped of
 * anything that could forge a second log line and truncated so a multi-kilobyte
 * path cannot bloat either sink.
 */
function safeHookId(id: string): string {
  return id.replace(/[^\w.:-]/g, '?').slice(0, 64);
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

/** Constant-time bearer check. Guards length first — `timingSafeEqual` throws
 *  on mismatched buffer lengths. */
function authorized(header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

const DEFAULT_HMAC_HEADER = 'x-signature';
const DEFAULT_HMAC_ALGORITHM = 'sha256';

/** Constant-time compare of two hex digests. Guards length first for the same
 *  reason `authorized()` does — `timingSafeEqual` throws on a length
 *  mismatch, and a thrown check is a 500, not a rejection. */
function digestMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify a payload signature over the RAW request body.
 *
 * Accepts a match against `cfg.secret` or, when set, `cfg.previousSecret` —
 * the rotation window, so an operator can roll the sender's secret without a
 * synchronized cutover.
 */
function hmacValid(rawBody: string, provided: string | undefined, cfg: WebhookHmacConfig): boolean {
  const signature = provided?.trim();
  if (!signature) return false;
  const algorithm = cfg.algorithm ?? DEFAULT_HMAC_ALGORITHM;
  const candidates = cfg.previousSecret ? [cfg.secret, cfg.previousSecret] : [cfg.secret];
  for (const secret of candidates) {
    let expected: string;
    try {
      expected = createHmac(algorithm, secret).update(rawBody).digest('hex');
    } catch {
      // `createHmac` throws on an algorithm OpenSSL doesn't know. Config
      // validation restricts the field to a small allowlist, but a hand-edited
      // file bypasses that — an unverifiable request is a rejected request,
      // never a 500 that tells the caller the server is broken.
      return false;
    }
    if (digestMatches(signature, expected)) return true;
  }
  return false;
}

/**
 * The listener plus one read-only query. Returned instead of a bare `Server`
 * so existing callers — which only ever hold it as a `Server` — keep working
 * unchanged; the accessor rides along on the same object.
 */
export type WebhookServer = Server & {
  /**
   * How many requests are currently parked on the SYNCHRONOUS reply path —
   * the ones holding an open HTTP connection while `gateway.handleMessage`
   * runs. Exists for an idle-watcher's busy predicate: stopping the process
   * here drops a caller's connection with no reply and no retry.
   *
   * `mode: 'ack'` requests are deliberately NOT counted. They are answered 202
   * before the turn starts and the turn itself runs detached inside the
   * gateway, where `Gateway.hasActiveTurns()` already sees it — counting them
   * here would double-count the same work.
   */
  inFlightSyncRequests(): number;
};

/**
 * Inbound webhook listener. Exposes `POST /webhook/<hookId>`: an external caller
 * supplies a bearer secret and a prompt; the handler synthesizes an
 * `InboundMessage` and drives the mapped personality through the existing
 * `Gateway.handleMessage` path, returning the agent's reply synchronously
 * (or a 202 ack with a detached turn when the hook sets `mode: 'ack'`).
 * An optional per-hook prefilter script gates/transforms the request before
 * any turn is dispatched.
 *
 * A hook may also name `deliver` targets — chats/channels its content is
 * relayed to in ADDITION to the HTTP response, for both `sync` and `ack` — and
 * may set `deliverOnly`, which relays the (raw or prefiltered) payload and
 * dispatches no turn at all. Both need `relayTargets` wired.
 *
 * The trailing `opts` groups the seams that have no positional home: the
 * parameter list is already seven long, so further injected collaborators go
 * in an object rather than extending the tail one boolean-blind slot at a time.
 * Existing positional parameters are untouched, so every call site compiles
 * unchanged.
 */
export function createWebhookServer(
  port: number,
  host: string,
  gateway: WebhookGateway,
  webhooks: Record<string, WebhookConfig>,
  createCapturingAdapter: CaptureFactory,
  runPrefilter?: PrefilterRunner,
  relayTargets?: DeliveryRelay,
  opts?: {
    /** Fired on every rejection. Wrapped — a throwing sink cannot fail a request. */
    onRejected?: WebhookRejectionSink;
    /** Clock seam for the rate limiter, so tests need no wall-clock waiting. */
    now?: () => number;
  },
): WebhookServer {
  /** Requests parked on the synchronous reply path. See `inFlightSyncRequests`. */
  let inFlightSync = 0;
  /** Rate-limit state, one bucket per hookId. Same closure as `inFlightSync`:
   *  per-process, per-server, gone when the listener is. */
  const rateBuckets = new Map<string, TokenBucket>();
  const clock = opts?.now ?? (() => Date.now());
  const onRejected = opts?.onRejected;

  /** Log a rejection and tell the observability sink, once, in one place.
   *  The sink is wrapped here rather than at six call sites — an operator's
   *  telemetry handler throwing must not turn a 401 into a 500. */
  const reject = (id: string, reason: WebhookRejectionReason): void => {
    console.warn(`[webhook] ${id}: rejected (${reason})`);
    if (!onRejected) return;
    try {
      onRejected(id, reason);
    } catch (err) {
      console.error('[webhook] rejection sink threw:', err);
    }
  };

  const server = createServer(async (req, res) => {
    const match = req.url ? WEBHOOK_PATH.exec(req.url) : null;
    if (req.method !== 'POST' || !match) {
      // NOT a hook rejection: no hookId exists to attribute it to. This is a
      // stray request to an address that is not a webhook endpoint at all —
      // counting it would drown the per-hook signal in scanner noise.
      res.writeHead(404);
      res.end();
      return;
    }
    const hookId = match[1];
    const hook = webhooks[hookId];
    if (!hook) {
      reject(safeHookId(hookId), 'unknown_hook');
      res.writeHead(404);
      res.end();
      return;
    }

    // Rate limiting runs BEFORE the bearer check on purpose: `timingSafeEqual`
    // cycles spent on traffic that is getting refused anyway are cycles an
    // attacker gets to choose. An absent `rateLimit` (or a non-positive
    // `maxPerMinute`) skips the bucket entirely — unlimited, exactly as before.
    const maxPerMinute = hook.rateLimit?.maxPerMinute;
    if (maxPerMinute !== undefined && maxPerMinute > 0) {
      const lockoutMs =
        (hook.rateLimit?.lockoutSeconds ?? DEFAULT_RATE_LIMIT_LOCKOUT_SECONDS) * 1000;
      const retryAfter = consumeRateLimitToken(
        rateBuckets,
        hookId,
        maxPerMinute,
        lockoutMs,
        clock(),
      );
      if (retryAfter !== undefined) {
        reject(hookId, 'rate_limited');
        sendJson(res, 429, { error: 'rate limited' }, { 'Retry-After': String(retryAfter) });
        return;
      }
    }

    if (!authorized(req.headers.authorization, hook.secret)) {
      reject(hookId, 'unauthorized');
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' });
      return;
    }

    // HMAC — payload integrity, verified against the RAW body bytes. This
    // block MUST stay between `readBody` and the `JSON.parse` below: a
    // signature covers exactly the bytes the sender signed, and re-serializing
    // a parsed object would not reproduce them (key order, whitespace,
    // number formatting). Do not reorder it past the parse.
    //
    // Additive to the bearer check above, never a replacement: that one ran
    // first because it needs no body and rejects an unauthenticated caller
    // before we spend a read on them. Both must pass when `hmac` is set.
    if (hook.hmac) {
      const header = hook.hmac.header ?? DEFAULT_HMAC_HEADER;
      if (!hmacValid(rawBody, headerValue(req, header), hook.hmac)) {
        // Deliberately distinct from the bearer failure's 'unauthorized':
        // an operator debugging a rotation needs to know which gate closed.
        reject(hookId, 'invalid_signature');
        sendJson(res, 401, { error: 'invalid signature' });
        return;
      }
    }

    // Parsed once, up front: the event filter below and the prompt derivation
    // further down both read this object. The prefilter is unaffected — it
    // takes the raw string, not the parsed value.
    let raw: unknown;
    let parseFailed = false;
    try {
      raw = JSON.parse(rawBody);
    } catch {
      parseFailed = true;
    }

    // Event filtering — cheaper than spawning the prefilter, so it runs first.
    // An absent or empty `events` list skips this path entirely, leaving every
    // pre-existing hook's behavior exactly as it was.
    if (hook.events && hook.events.length > 0) {
      const fromHeader = headerValue(req, hook.eventHeader ?? DEFAULT_EVENT_HEADER)?.trim();
      let eventName = fromHeader && fromHeader.length > 0 ? fromHeader : undefined;
      if (eventName === undefined && !parseFailed) {
        // Read the PRE-zod object: `WebhookBody` strips unknown keys, and the
        // event name is always one of them.
        const fromBody = lookupPath(raw, hook.eventField ?? DEFAULT_EVENT_FIELD);
        if (typeof fromBody === 'string' && fromBody.trim().length > 0) {
          eventName = fromBody.trim();
        }
      }
      if (eventName === undefined) {
        // Fail closed, the same doctrine the prefilter applies below: an
        // inbound POST is untrusted input, so one whose event cannot be
        // classified is rejected rather than waved through to the agent.
        reject(hookId, 'unclassifiable_event');
        sendJson(res, 400, { error: 'cannot determine event type' });
        return;
      }
      if (!hook.events.includes(eventName)) {
        console.log(`[webhook] ${hookId}: filtered by event "${eventName}" — no turn`);
        sendJson(res, 200, { filtered: true, reason: 'event' });
        return;
      }
    }

    // Prefilter — a deterministic operator script decides whether this POST
    // becomes a turn at all (plan gap-event-triggers §3d). Fail-closed: an
    // inbound POST is untrusted input, so any script failure rejects the
    // request instead of waking the agent (the asymmetry with cron's
    // fail-open precheck is deliberate — plan §5 risk 2).
    let prefilteredPrompt: string | undefined;
    if (hook.prefilter) {
      const file = hook.prefilter;
      const timeoutSeconds = hook.prefilterTimeoutSeconds ?? DEFAULT_PREFILTER_TIMEOUT_SECONDS;
      let outcome: PrefilterOutcome;
      if (!runPrefilter) {
        outcome = { ok: false, exitCode: null, stdout: '', failure: 'no prefilter runner wired' };
      } else {
        try {
          outcome = await runPrefilter(file, { stdin: rawBody, timeoutSeconds });
        } catch (err) {
          outcome = {
            ok: false,
            exitCode: null,
            stdout: '',
            failure: err instanceof Error ? err.message : String(err),
          };
        }
      }
      if (outcome.ok && outcome.exitCode === PREFILTER_FILTERED_EXIT_CODE) {
        console.log(`[webhook] ${hookId}: filtered by prefilter "${file}" — no turn`);
        sendJson(res, 200, { filtered: true });
        return;
      }
      if (!outcome.ok || outcome.exitCode !== 0) {
        // Two lines on purpose: `reject` emits the uniform, greppable reason
        // every rejection path shares; this one carries the detail only the
        // prefilter has.
        console.error(
          `[webhook] ${hookId}: prefilter "${file}" failed — request rejected:`,
          outcome.failure ?? `exit code ${outcome.exitCode}`,
        );
        reject(hookId, 'prefilter_failed');
        sendJson(res, 500, { error: 'prefilter failed' });
        return;
      }
      // Exit 0: non-empty stdout replaces the body-derived prompt; empty
      // stdout keeps it. Stdout is secret-redacted by the runner but is still
      // untrusted webhook input — it gets exactly the body prompt's treatment.
      const replaced = outcome.stdout.trim();
      if (replaced) prefilteredPrompt = replaced;
    }

    // Deliver-only — relay the payload, dispatch no turn. The `WebhookBody`
    // prompt/text check below is deliberately skipped: there is no prompt in
    // this mode, so a raw non-JSON payload is a legitimate request. The
    // prefilter still ran above, since a script may gate or transform the
    // content even when no model will see it.
    if (hook.deliverOnly === true) {
      const content = prefilteredPrompt ?? rawBody;
      if (!relayTargets) {
        // Fail visibly, the same posture as the prefilter's missing-runner
        // path: a hook configured to deliver somewhere must not silently 200.
        console.error(`[webhook] ${hookId}: deliverOnly configured but no delivery relay wired`);
        sendJson(res, 500, { error: 'no delivery relay wired' });
        return;
      }
      const delivered = await relayTargets(hook.deliver ?? [], content, {
        hookId,
        sessionKey: hook.sessionKey ?? hookId,
      });
      sendJson(res, 200, { delivered });
      return;
    }

    let prompt: string;
    let msgRaw: unknown;
    if (prefilteredPrompt !== undefined) {
      prompt = prefilteredPrompt;
      // A prefilter may accept non-JSON payloads — the original body rides
      // along as `raw` in whatever form it arrived.
      msgRaw = parseFailed ? rawBody : raw;
    } else {
      if (parseFailed) {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const parsed = WebhookBody.safeParse(raw);
      if (!parsed.success) {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const body = parsed.data;
      // TODO v2: attachments
      const bodyPrompt = body.prompt ?? body.text;
      if (!bodyPrompt || bodyPrompt.trim().length === 0) {
        sendJson(res, 400, { error: "missing 'prompt'" });
        return;
      }
      prompt = bodyPrompt;
      msgRaw = body;
    }

    const msg: InboundMessage = {
      platform: 'webhook',
      chatId: hook.sessionKey ?? hookId,
      text: prompt,
      isDm: true,
      isGroupMention: false,
      botKey: `webhook:${hookId}`,
      messageId: `${Date.now()}-${requestCounter++}`,
      raw: msgRaw,
    };

    const { adapter, getReply } = createCapturingAdapter();

    /** Fan the agent's reply out to the hook's `deliver` targets, in ADDITION
     *  to the HTTP response. Never throws — a relay failure must not turn a
     *  reply the caller already has into an error. */
    const relayReply = async (): Promise<void> => {
      const targets = hook.deliver;
      if (!targets || targets.length === 0) return;
      const content = getReply();
      if (!content || content.trim().length === 0) return;
      if (!relayTargets) {
        console.error(
          `[webhook] ${hookId}: deliver targets configured but no delivery relay wired`,
        );
        return;
      }
      await relayTargets(targets, content, { hookId, sessionKey: hook.sessionKey ?? hookId });
    };

    // mode 'ack' — 202 immediately, turn runs detached. Fixes the
    // held-connection problem for GitHub/Stripe-style callers that enforce
    // short delivery timeouts (plan gap-event-triggers §3d).
    if (hook.mode === 'ack') {
      console.log(`[webhook] ${hookId}: accepted (ack mode) — turn running detached`);
      sendJson(res, 202, { accepted: true });
      // The relay is chained onto the detached turn, so it runs once the turn
      // has actually produced a reply. This is the only destination an
      // ack-mode reply has ever had — before `deliver`, it was discarded.
      void gateway
        .handleMessage(msg, adapter)
        .then(relayReply)
        .catch((err) => {
          console.error(`[webhook] ${hookId}: detached turn error:`, err);
        });
      return;
    }
    // Per-request read so tests (and operators) can override the timeout at
    // runtime, not just at module load.
    const timeoutMs = Number(process.env.ETHOS_WEBHOOK_TIMEOUT_MS) || 60_000;

    let timer: NodeJS.Timeout | undefined;
    let responded = false;
    inFlightSync++;
    try {
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const result = await Promise.race([
        gateway.handleMessage(msg, adapter).then(() => 'done' as const),
        timeout,
      ]);
      responded = true;
      if (result === 'timeout') {
        sendJson(res, 504, { error: 'timeout' });
      } else {
        // Respond FIRST — the caller must not wait on the fan-out. Detached
        // and caught: a failing relay can never turn a delivered reply into a
        // 500. Only on 'done': a timed-out or errored turn has no reply to
        // relay.
        sendJson(res, 200, { reply: getReply() });
        void relayReply().catch((err) => {
          console.error(`[webhook] ${hookId}: deliver fan-out error:`, err);
        });
      }
    } catch (err) {
      if (!responded) {
        console.error('[webhook] handler error:', err);
        sendJson(res, 500, { error: 'internal error' });
      }
    } finally {
      inFlightSync--;
      if (timer) clearTimeout(timer);
    }
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(
        `[webhook] port ${port} in use — webhook endpoint unavailable. ` +
          'Set ETHOS_WEBHOOK_PORT to change.',
      );
    }
  });
  server.listen(port, host);
  server.unref();
  return Object.assign(server, { inFlightSyncRequests: () => inFlightSync });
}
