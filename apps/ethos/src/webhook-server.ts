import { timingSafeEqual } from 'node:crypto';
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
   *  replaces the prompt (empty stdout keeps the body-derived prompt);
   *  exit 78 → request filtered, no turn; anything else → 500, no turn. */
  prefilter?: string;
  /** Wall-clock limit for the prefilter in seconds. Default 30, max 600. */
  prefilterTimeoutSeconds?: number;
  /** 'sync' (default) holds the connection for the agent's reply;
   *  'ack' responds 202 immediately and runs the turn detached. */
  mode?: 'sync' | 'ack';
}

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

/** Constant-time bearer check. Guards length first — `timingSafeEqual` throws
 *  on mismatched buffer lengths. */
function authorized(header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
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
 */
export function createWebhookServer(
  port: number,
  host: string,
  gateway: WebhookGateway,
  webhooks: Record<string, WebhookConfig>,
  createCapturingAdapter: CaptureFactory,
  runPrefilter?: PrefilterRunner,
): WebhookServer {
  /** Requests parked on the synchronous reply path. See `inFlightSyncRequests`. */
  let inFlightSync = 0;
  const server = createServer(async (req, res) => {
    const match = req.url ? WEBHOOK_PATH.exec(req.url) : null;
    if (req.method !== 'POST' || !match) {
      res.writeHead(404);
      res.end();
      return;
    }
    const hookId = match[1];
    const hook = webhooks[hookId];
    if (!hook) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (!authorized(req.headers.authorization, hook.secret)) {
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
        console.error(
          `[webhook] ${hookId}: prefilter "${file}" failed — request rejected:`,
          outcome.failure ?? `exit code ${outcome.exitCode}`,
        );
        sendJson(res, 500, { error: 'prefilter failed' });
        return;
      }
      // Exit 0: non-empty stdout replaces the body-derived prompt; empty
      // stdout keeps it. Stdout is secret-redacted by the runner but is still
      // untrusted webhook input — it gets exactly the body prompt's treatment.
      const replaced = outcome.stdout.trim();
      if (replaced) prefilteredPrompt = replaced;
    }

    let raw: unknown;
    let parseFailed = false;
    try {
      raw = JSON.parse(rawBody);
    } catch {
      parseFailed = true;
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

    // mode 'ack' — 202 immediately, turn runs detached. Fixes the
    // held-connection problem for GitHub/Stripe-style callers that enforce
    // short delivery timeouts (plan gap-event-triggers §3d).
    if (hook.mode === 'ack') {
      console.log(`[webhook] ${hookId}: accepted (ack mode) — turn running detached`);
      sendJson(res, 202, { accepted: true });
      void gateway.handleMessage(msg, adapter).catch((err) => {
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
        sendJson(res, 200, { reply: getReply() });
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
