// A2A JSON-RPC server + execute-task wrap (Phase 5 sync + Phase 6 async).
//
// The `/a2a/<personalityId>` endpoint is the authenticated talk surface. It is
// mounted `public` through the Phase-2 RouteModule seam and owns its OWN access
// control — it does NOT ride the main API's cookie/bearer auth, because an A2A
// caller presents an A2A-minted EdDSA JWT plus a per-request proof-of-possession,
// neither of which is the web-api credential. Every failure is a JSON-RPC error
// envelope (HTTP stays 200, per JSON-RPC-over-HTTP).
//
// Gates, in order (plan §4 / P3 / P5 / P8):
//   1. TOKEN      — the sender-constrained JWT validates (jose sig + exp + cnf +
//                   revocation gate against the peer store).
//   2. PoP        — a per-request signature over the DOMAIN-SEPARATED struct
//                   { context:'a2a-request-pop', method, jti, timestamp } verifies
//                   against the token's bound peer key (`cnf.jkt`). A stolen token
//                   WITHOUT the peer's private key cannot produce this → REJECT.
//                   Replay-guarded: short timestamp window + single-use signature.
//   3. DELEGATION — the SIGNED in-envelope trace id + call depth (plan §P8). The
//                   server reads the SIGNED depth (a plain header is ignored) and
//                   rejects depth ≥ MAX_DEPTH. Fan-out is bounded per trace id.
//   4. SCOPE      — the requested `skill` must be in BOTH the token's granted
//                   scope AND the personality's CURRENT character sheet, re-read
//                   via `getIdentity(...,'trusted-peer')` AT CALL TIME.
//
// Sync path: collect the AgentEvent stream → completed/failed and return inline.
// Async path (Phase 6): dedupe on the idempotency key, return { taskId,
// status:'submitted' } immediately, and run in the background via the injected
// A2aAsyncManager (working→completed/failed).
//
// Layer-clean: imports only `@ethosagent/types` (the AgentEvent TYPE + the
// identity contract), `hono`, `jose`, and sibling `./` modules (which bottom out
// at `node:crypto`). No core, no extensions, no apps — the runner is injected.

import { randomUUID } from 'node:crypto';
import { type A2aIdentityProvider, type AgentEvent, EthosError } from '@ethosagent/types';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { decodeJwt } from 'jose';
import { A2aAsyncManager, collectAgentRun } from './async';
import { type A2aAuditSink, safeAudit } from './audit';
import { fingerprint, verifyStruct } from './crypto';
import { type A2aDelegationCredentials, A2aDelegationGuard } from './delegation';
import { type A2aPreAuthLimiter, NOOP_PRE_AUTH_LIMITER } from './limiter';
import type { A2aPeerStore } from './stores';
import {
  type A2aTask,
  type A2aTaskStatus,
  type A2aTaskStore,
  isTerminalStatus,
} from './task-store';
import { type A2aTokenClaims, validateToken } from './tokens';

// ---------------------------------------------------------------------------
// Injected task runner — mirrors ACP's `AgentRunner` (apps/acp-server).
// ---------------------------------------------------------------------------

/**
 * The execute-task seam. `packages/a2a` consumes the AgentEvent stream and maps
 * it to a task result; it NEVER imports core. The serve/web-api wiring provides
 * the concrete impl that calls the real `AgentLoop.run` (plan §2 / §10, mirrors
 * how ACP wires its runner to the loop).
 */
export interface A2aTaskRunner {
  run(
    personalityId: string,
    text: string,
    opts?: {
      sessionKey?: string;
      /**
       * The admitted inbound trace + signed depth (plan §P8). The runner threads
       * it onto `ToolContext.a2aDelegation` so an onward outbound A2A call signs
       * `depth + 1` and consumes the per-trace fan-out budget. Absent for a fresh
       * top-level call the runner does not need to contain.
       */
      delegation?: { traceId: string; depth: number };
      /**
       * The peer-named skill from `A2aMessageSendParams.skill` (plan T0.2 /
       * D8). Already authorized by the scope gate above — this is ONLY the
       * narrowing input. The runner is responsible for resolving it to a
       * `RunOptions.toolsetNarrow` (walking `skillsDirs` + parsing SKILL.md,
       * fail-closed per D2) before it hands the turn a toolset; `packages/a2a`
       * stays layer-clean and does none of that resolution itself.
       */
      skill?: string;
    },
  ): AsyncIterable<AgentEvent>;
}

// ---------------------------------------------------------------------------
// Isolatable limiter hook (plan §12 blast-radius mitigation seam; §O6 caps).
// ---------------------------------------------------------------------------

/**
 * Optional per-request limiter (rate + concurrency). `acquire` returns a lease
 * to release when the task finishes, or `null` to reject the request (rate or
 * concurrency cap exceeded → typed JSON-RPC busy `-32004`). This is the §12 seam
 * that keeps A2A abuse from taking down the rest of the API even though it is
 * mounted in-process. The real caps live in `MemoryA2aLimiter` (`./limiter`).
 */
export interface A2aLimiter {
  acquire(personalityId: string, peerFingerprint: string): Promise<A2aLease | null>;
}

export interface A2aLease {
  release(): void;
}

const NOOP_LIMITER: A2aLimiter = {
  async acquire() {
    return { release() {} };
  },
};

// ---------------------------------------------------------------------------
// Per-request proof-of-possession (plan §0A / §9).
// ---------------------------------------------------------------------------

export const A2A_REQUEST_POP_CONTEXT = 'a2a-request-pop' as const;

/** The domain-separated struct the peer signs on every `/a2a` request. */
export interface A2aRequestPopStruct {
  context: typeof A2A_REQUEST_POP_CONTEXT;
  /** The JSON-RPC method (or SSE pseudo-method) being called. */
  method: string;
  /** The presented token's id — a proof for token T is useless for token T'. */
  jti: string;
  /** ms epoch — replay-guarded by a short window + single-use. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope + error codes.
// ---------------------------------------------------------------------------

type JsonRpcId = number | string | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcErrorResponse;

/** JSON-RPC method name for A2A `tasks/send` (plan §10). */
export const A2A_METHOD_MESSAGE_SEND = 'message/send' as const;
/** Pseudo-method bound into the PoP for the task-events SSE stream. */
export const A2A_METHOD_TASKS_SUBSCRIBE = 'tasks/subscribe' as const;

const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  // Application errors (JSON-RPC server-defined range).
  EXECUTION_FAILED: -32000,
  UNAUTHORIZED: -32001,
  PROOF_INVALID: -32002,
  FORBIDDEN_SCOPE: -32003,
  RATE_LIMITED: -32004,
  DELEGATION_REJECTED: -32005,
  PAYLOAD_TOO_LARGE: -32006,
} as const;

/** Auth-rejection JSON-RPC codes (plan T1.2/D13) — exported so a session cache
 *  (e.g. `extensions/tools-a2a`) can recognize "the peer rejected MY token" and
 *  invalidate a cached session, without duplicating the magic numbers. */
export const A2A_RPC_AUTH_ERROR_CODES = {
  UNAUTHORIZED: RPC.UNAUTHORIZED,
  PROOF_INVALID: RPC.PROOF_INVALID,
} as const;

// ---------------------------------------------------------------------------
// Request credentials + params.
// ---------------------------------------------------------------------------

/** Credentials pulled off the HTTP request by the router (or a test). */
export interface A2aRequestCredentials {
  /** The A2A access token (the `Authorization: Bearer <token>` value). */
  token: string | null;
  /** base64 Ed25519 signature over the {@link A2aRequestPopStruct}. */
  proofSignature: string | null;
  /** ms epoch echoed from the signed proof struct. */
  proofTimestamp: number | null;
  /**
   * The SIGNED delegation envelope (plan §P8). Absent → a fresh top-level call.
   * The server reads the signed depth here — a plain `depth` header is ignored.
   */
  delegation?: A2aDelegationCredentials;
  /**
   * Best-effort caller identifier for the PRE-AUTH limiter (plan T1.4) — in
   * practice the remote address. Optional so every existing direct-service
   * caller (tests, other callers of `handleRpc`) is unaffected; absent →
   * `'unknown'`, which the default no-op limiter never rejects anyway. NOT an
   * authenticated identity — it exists only to bound CPU before crypto runs.
   */
  remoteKey?: string;
  /**
   * An UNVERIFIED, caller-claimed fingerprint (e.g. from a header), present
   * only to widen how a legitimate multi-peer proxy is shaped by the pre-auth
   * limiter. Never treated as identity or authorization — that is what the
   * real token + PoP gates below are for. Not currently mixed into the
   * pre-auth limiter key (see T1.4 note in rpc.ts): doing so naively would let
   * an attacker vary the header per request to dodge the remote-address cap.
   * Carried on the credentials so a future limiter can use it deliberately.
   */
  claimedFingerprint?: string;
}

/** `message/send` params (sync + async). */
export interface A2aMessageSendParams {
  /** Target capability — enforced against scope ∩ current character sheet. */
  skill: string;
  /** The message text handed to the agent loop. */
  message: string;
  /** Optional session key; defaults to `a2a:<personalityId>:<peerFingerprint>`. */
  sessionKey?: string;
  /** `'async'` returns a taskId immediately and runs in the background. Default `'sync'`. */
  mode?: 'sync' | 'async';
  /** Dedupe key — a retried send with the same key does NOT re-run the loop. */
  idempotencyKey?: string;
}

/** The sync task result returned as the JSON-RPC `result`. */
export interface A2aTaskResult {
  taskId: string;
  state: 'completed' | 'failed';
  text: string;
  /** Present when `state === 'failed'`. */
  error?: string;
}

/** The async submit acknowledgement returned as the JSON-RPC `result`. */
export interface A2aAsyncSubmitResult {
  taskId: string;
  status: A2aTaskStatus;
}

// ---------------------------------------------------------------------------
// Service.
// ---------------------------------------------------------------------------

export interface A2aRpcServiceOptions {
  /**
   * Read-only identity projection. Re-read AT CALL TIME for the current
   * character sheet (scope ∩) and the target public key that validates tokens.
   */
  getIdentity: A2aIdentityProvider;
  /** Peer store — recovers the bound peer key for PoP + the revocation gate. */
  peerStore: A2aPeerStore;
  /** The execute-task seam (injected AgentLoop wrapper). */
  runner: A2aTaskRunner;
  /** Injectable clock (ms epoch). Default `Date.now`. */
  now?: () => number;
  /** PoP timestamp window in ms (replay guard). Default 60_000. */
  popWindowMs?: number;
  /** Isolatable limiter (plan §12 / §O6). Default no-op. */
  limiter?: A2aLimiter;
  /** P8 delegation containment (depth ceiling + fan-out budget). Default a fresh guard. */
  delegationGuard?: A2aDelegationGuard;
  /**
   * Async task store — enables the async `mode:'async'` path + the SSE stream.
   * Omit to serve sync-only (async requests then return an execution error).
   */
  taskStore?: A2aTaskStore;
  /**
   * Metadata-only audit sink (plan §13 / Phase 8). Records gate denials, accepted
   * dispatches, and terminal task state — fail-open, never a message body. Omit
   * to disable auditing entirely.
   */
  auditSink?: A2aAuditSink;
  /**
   * PRE-AUTH limiter (plan T1.4) — cheap, coarse, keyed on `creds.remoteKey`.
   * Checked BEFORE `authenticate()` so an unauthenticated flood never reaches
   * token validation or per-request PoP verification (both Ed25519/JWT
   * operations). This is ADDITIVE to the existing post-auth `limiter` above,
   * not a replacement — that one enforces a per-peer quota; this one bounds
   * CPU spent on crypto for callers who have proven nothing yet. Default a
   * permissive no-op (existing callers unaffected).
   */
  preAuthLimiter?: A2aPreAuthLimiter;
  /**
   * Max JSON-RPC request body size in bytes (plan T1.4 — "rate limit ≠ 200MB
   * body"). Checked by the router before `JSON.parse`. Default 1_000_000 (1MB).
   */
  maxBodyBytes?: number;
  /**
   * Max concurrent SSE task-subscription streams, process-wide (plan T1.4).
   * A new connection attempt once at the cap is refused before `authenticate()`
   * even runs. Default 100.
   */
  maxSseConnections?: number;
}

/** Result of the shared token+PoP authentication gate (reused by RPC + SSE). */
export type A2aAuthResult =
  | {
      ok: true;
      claims: A2aTokenClaims;
      peerFingerprint: string;
      peerPublicKey: Buffer;
      sheetSkills: Set<string>;
    }
  | { ok: false; code: number; reason: string };

export interface A2aRpcService {
  handleRpc(
    personalityId: string,
    request: unknown,
    creds: A2aRequestCredentials,
  ): Promise<JsonRpcResponse>;
  /** Token + per-request PoP gate only (no scope) — the SSE stream reuses this. */
  authenticate(
    personalityId: string,
    method: string,
    creds: A2aRequestCredentials,
  ): Promise<A2aAuthResult>;
  /**
   * PRE-AUTH gate (plan T1.4) — cheap, coarse, keyed on remote address. False
   * → the caller must reject WITHOUT calling `authenticate()`. Exposed so the
   * SSE route (which calls `authenticate()` directly, not `handleRpc`) applies
   * the same gate `handleRpc` applies internally.
   */
  checkPreAuth(remoteKey: string): boolean;
  /**
   * Reserve one SSE connection slot against the process-wide cap (plan T1.4).
   * Returns `null` when at capacity — the caller must refuse the connection
   * without opening a stream. Release the returned handle when the stream
   * closes (abort or terminal state).
   */
  acquireSseSlot(): A2aLease | null;
}

export function createA2aRpcService(opts: A2aRpcServiceOptions): A2aRpcService {
  const now = opts.now ?? Date.now;
  const popWindowMs = opts.popWindowMs ?? 60_000;
  const limiter = opts.limiter ?? NOOP_LIMITER;
  const delegationGuard = opts.delegationGuard ?? new A2aDelegationGuard();
  const auditSink = opts.auditSink;
  const preAuthLimiter = opts.preAuthLimiter ?? NOOP_PRE_AUTH_LIMITER;
  const maxSseConnections = opts.maxSseConnections ?? 100;
  let openSseConnections = 0;
  const asyncManager = opts.taskStore
    ? new A2aAsyncManager({
        taskStore: opts.taskStore,
        runner: opts.runner,
        now,
        ...(auditSink ? { auditSink } : {}),
        onSettled: (traceId) => delegationGuard.releaseTrace(traceId),
      })
    : null;

  // Single-use PoP signatures within the window (replay guard, plan §9). Keyed
  // by the signature; value is the ms-epoch expiry. In-process for the single-
  // process v1 — moves to shared storage if the server scales out.
  const usedProofs = new Map<string, number>();
  function sweepProofs(nowMs: number): void {
    for (const [sig, exp] of usedProofs) {
      if (exp <= nowMs) usedProofs.delete(sig);
    }
  }

  async function authenticate(
    personalityId: string,
    method: string,
    creds: A2aRequestCredentials,
  ): Promise<A2aAuthResult> {
    // --- Gate 1: token -----------------------------------------------------
    if (!creds.token) {
      return { ok: false, code: RPC.UNAUTHORIZED, reason: 'missing access token' };
    }
    const jkt = peekCnfJkt(creds.token);
    if (jkt === null) {
      return {
        ok: false,
        code: RPC.UNAUTHORIZED,
        reason: 'malformed token or missing sender-constraint',
      };
    }

    // Current identity — one read serves BOTH the target public key (validates
    // the token) AND the current character-sheet skills (scope ∩, at call time).
    let targetPublicKey: Buffer;
    let sheetSkills: Set<string>;
    try {
      const card = await opts.getIdentity.getIdentity(personalityId, 'trusted-peer');
      targetPublicKey = Buffer.from(card.publicKey, 'base64');
      sheetSkills = new Set(card.skills.map((s) => s.name));
    } catch (err) {
      if (err instanceof EthosError && err.code === 'PERSONALITY_NOT_FOUND') {
        return {
          ok: false,
          code: RPC.UNAUTHORIZED,
          reason: `unknown personality "${personalityId}"`,
        };
      }
      return { ok: false, code: RPC.INTERNAL, reason: 'identity lookup failed' };
    }

    const validation = await validateToken(creds.token, {
      targetPublicKey,
      presentedFingerprint: jkt,
      issuer: personalityId,
      audience: personalityId,
      now: now(),
      peerStore: opts.peerStore,
      personalityId,
    });
    if (!validation.ok) {
      return { ok: false, code: RPC.UNAUTHORIZED, reason: `token rejected: ${validation.reason}` };
    }
    const claims = validation.claims;

    // --- Gate 2: per-request proof-of-possession ---------------------------
    if (!creds.proofSignature || creds.proofTimestamp === null) {
      return { ok: false, code: RPC.PROOF_INVALID, reason: 'missing proof-of-possession' };
    }
    const nowMs = now();
    if (Math.abs(nowMs - creds.proofTimestamp) > popWindowMs) {
      return {
        ok: false,
        code: RPC.PROOF_INVALID,
        reason: 'proof timestamp outside allowed window',
      };
    }
    sweepProofs(nowMs);
    if (usedProofs.has(creds.proofSignature)) {
      return { ok: false, code: RPC.PROOF_INVALID, reason: 'proof already used (replay)' };
    }
    const entry = await opts.peerStore.get(personalityId, jkt);
    if (!entry) {
      return { ok: false, code: RPC.UNAUTHORIZED, reason: 'unknown peer' };
    }
    const peerPublicKey = Buffer.from(entry.card.publicKey, 'base64');
    if (fingerprint(peerPublicKey) !== jkt) {
      return { ok: false, code: RPC.UNAUTHORIZED, reason: 'peer key/fingerprint mismatch' };
    }
    const popStruct: A2aRequestPopStruct = {
      context: A2A_REQUEST_POP_CONTEXT,
      method,
      jti: claims.jti,
      timestamp: creds.proofTimestamp,
    };
    if (!verifyStruct(popStruct, creds.proofSignature, peerPublicKey)) {
      return {
        ok: false,
        code: RPC.PROOF_INVALID,
        reason: 'proof-of-possession signature invalid',
      };
    }
    // Burn the proof only once it is proven valid (single-use within the window).
    usedProofs.set(creds.proofSignature, nowMs + popWindowMs);

    return { ok: true, claims, peerFingerprint: jkt, peerPublicKey, sheetSkills };
  }

  function checkPreAuth(remoteKey: string): boolean {
    return preAuthLimiter.check(remoteKey);
  }

  function acquireSseSlot(): A2aLease | null {
    if (openSseConnections >= maxSseConnections) return null;
    openSseConnections += 1;
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        openSseConnections = Math.max(0, openSseConnections - 1);
      },
    };
  }

  async function handleRpc(
    personalityId: string,
    request: unknown,
    creds: A2aRequestCredentials,
  ): Promise<JsonRpcResponse> {
    if (!isJsonRpcRequest(request)) {
      return errorResponse(null, RPC.INVALID_REQUEST, 'invalid JSON-RPC 2.0 request');
    }
    const id = request.id ?? null;

    // Metadata-only audit of a gate denial (fail-open). Only identifiers/labels
    // are ever passed — never the message body.
    const auditDenied = (reason: string, extra: { peerFingerprint?: string; traceId?: string }) => {
      safeAudit(auditSink, {
        kind: 'rpc',
        event: A2A_METHOD_MESSAGE_SEND,
        personalityId,
        decision: 'denied',
        reason,
        severity: 'warn',
        ts: now(),
        ...(extra.peerFingerprint ? { peerFingerprint: extra.peerFingerprint } : {}),
        ...(extra.traceId ? { traceId: extra.traceId } : {}),
      });
    };

    // --- Gate 0: pre-auth rate limit (plan T1.4) ---------------------------
    // Cheap, coarse, keyed on remote address — runs BEFORE `authenticate()` so
    // an unauthenticated flood never reaches token validation or per-request
    // PoP verification (both Ed25519/JWT operations). Runs ahead of even the
    // method/params shape checks below, for the same reason.
    if (!checkPreAuth(creds.remoteKey ?? 'unknown')) {
      auditDenied('pre-auth-rate-limited', {});
      return errorResponse(id, RPC.RATE_LIMITED, 'too many requests');
    }

    if (request.method !== A2A_METHOD_MESSAGE_SEND) {
      return errorResponse(id, RPC.METHOD_NOT_FOUND, `method not found: ${request.method}`);
    }
    if (!isMessageSendParams(request.params)) {
      return errorResponse(id, RPC.INVALID_PARAMS, 'invalid message/send params');
    }
    const params = request.params;

    // --- Gates 1+2: token + PoP -------------------------------------------
    // (Recorded HERE, not inside `authenticate` — that gate is shared with the
    // SSE subscribe path, and logging there would double-count.)
    const auth = await authenticate(personalityId, request.method, creds);
    if (!auth.ok) {
      auditDenied(rpcReasonLabel(auth.code), {});
      return errorResponse(id, auth.code, auth.reason);
    }
    const { claims, peerFingerprint, peerPublicKey, sheetSkills } = auth;

    // --- Gate 3: delegation containment (signed depth ≤ MAX) ---------------
    const delegationCreds: A2aDelegationCredentials = creds.delegation ?? {
      traceId: null,
      depth: null,
      signature: null,
    };
    const admission = delegationGuard.admitInbound(delegationCreds, peerPublicKey);
    if (!admission.ok) {
      auditDenied('delegation-rejected', { peerFingerprint });
      return errorResponse(id, RPC.DELEGATION_REJECTED, admission.reason);
    }
    const { traceId, depth } = admission;

    // --- Gate 4: scope ∩ current character sheet (evaluated at call time) ---
    // `*` is the full-access marker (plan §2a): it grants any skill the token's
    // scope covers, but ONLY as far as the sheet-intersection below still allows
    // — so `*` can never reach a skill the owner has not exposed. Empty scope
    // `[]` keeps its deny-all meaning.
    const skill = params.skill;
    if (!claims.scope.includes(skill) && !claims.scope.includes('*')) {
      auditDenied('forbidden-scope', { peerFingerprint, traceId });
      return errorResponse(id, RPC.FORBIDDEN_SCOPE, `skill "${skill}" not in granted scope`);
    }
    if (!sheetSkills.has(skill)) {
      auditDenied('forbidden-scope', { peerFingerprint, traceId });
      return errorResponse(
        id,
        RPC.FORBIDDEN_SCOPE,
        `skill "${skill}" not in the personality's current character sheet`,
      );
    }

    // Stamp inbound "last seen" (plan §11) — authenticated + authorized; fail-open
    // so a touch error never affects the RPC outcome.
    if (typeof opts.peerStore.touchLastSeen === 'function') {
      try {
        await opts.peerStore.touchLastSeen(personalityId, peerFingerprint, now());
      } catch {
        // fail-open
      }
    }

    const sessionKey = params.sessionKey ?? `a2a:${personalityId}:${peerFingerprint}`;

    // Record the ACCEPTED dispatch once the last gate — the limiter — also grants
    // a lease (a throttled request is a `rate-limited` denial, not an accept).
    const auditAccepted = () => {
      safeAudit(auditSink, {
        kind: 'rpc',
        event: A2A_METHOD_MESSAGE_SEND,
        personalityId,
        peerFingerprint,
        skill,
        traceId,
        decision: 'accepted',
        severity: 'info',
        ts: now(),
      });
    };

    // --- Async path (Phase 6) ---------------------------------------------
    if (params.mode === 'async') {
      if (!asyncManager || !opts.taskStore) {
        return errorResponse(
          id,
          RPC.EXECUTION_FAILED,
          'async tasks are not enabled on this server',
        );
      }
      const idempotencyKey = params.idempotencyKey ?? randomUUID();
      // Idempotency dedupe (plan §10): a retried send returns the prior task and
      // does NOT acquire a lease or re-run the loop.
      const existing = await opts.taskStore.findByIdempotencyKey(peerFingerprint, idempotencyKey);
      if (existing) {
        const result: A2aAsyncSubmitResult = { taskId: existing.id, status: existing.status };
        return { jsonrpc: '2.0', id, result };
      }
      // The lease is held for the whole background run (concurrency cap, §O6).
      const lease = await limiter.acquire(personalityId, peerFingerprint);
      if (!lease) {
        auditDenied('rate-limited', { peerFingerprint, traceId });
        return errorResponse(id, RPC.RATE_LIMITED, 'rate or concurrency limit exceeded');
      }
      auditAccepted();
      const task = await asyncManager.submit({
        personalityId,
        peerFingerprint,
        message: params.message,
        sessionKey,
        skill,
        traceId,
        depth,
        idempotencyKey,
      });
      const settled = asyncManager.settled(task.id) ?? Promise.resolve<A2aTask | null>(null);
      void settled.finally(() => lease.release());
      const result: A2aAsyncSubmitResult = { taskId: task.id, status: task.status };
      return { jsonrpc: '2.0', id, result };
    }

    // --- Sync path (Phase 5) — limiter around the run ----------------------
    const lease = await limiter.acquire(personalityId, peerFingerprint);
    if (!lease) {
      auditDenied('rate-limited', { peerFingerprint, traceId });
      return errorResponse(id, RPC.RATE_LIMITED, 'rate or concurrency limit exceeded');
    }
    auditAccepted();
    try {
      const result = await runSyncTask(
        opts.runner,
        personalityId,
        params.message,
        sessionKey,
        skill,
        { traceId, depth },
      );
      // Sync terminal task-state (fail-open, metadata only).
      safeAudit(auditSink, {
        kind: 'task',
        event: 'task-state',
        personalityId,
        peerFingerprint,
        taskId: result.taskId,
        traceId,
        status: result.state,
        decision: 'accepted',
        severity: result.state === 'failed' ? 'error' : 'info',
        ts: now(),
      });
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(id, RPC.EXECUTION_FAILED, `task execution failed: ${message}`);
    } finally {
      lease.release();
      delegationGuard.releaseTrace(traceId);
    }
  }

  return { handleRpc, authenticate, checkPreAuth, acquireSseSlot };
}

/** Sync path: collect the stream (shared mapping) into an {@link A2aTaskResult}. */
async function runSyncTask(
  runner: A2aTaskRunner,
  personalityId: string,
  text: string,
  sessionKey: string,
  skill: string,
  delegation: { traceId: string; depth: number },
): Promise<A2aTaskResult> {
  const taskId = randomUUID();
  const { text: finalText, error } = await collectAgentRun(
    runner.run(personalityId, text, { sessionKey, skill, delegation }),
  );
  if (error !== undefined) {
    return { taskId, state: 'failed', text: finalText, error };
  }
  return { taskId, state: 'completed', text: finalText };
}

// ---------------------------------------------------------------------------
// Router — thin HTTP adapter over the service.
// ---------------------------------------------------------------------------

/**
 * Build the `/a2a` Hono sub-router. Routes are RELATIVE to the RouteModule
 * basePath `/a2a`, yielding:
 *
 *   POST /a2a/:personalityId                      JSON-RPC 2.0 (`message/send`)
 *   GET  /a2a/:personalityId/tasks/:taskId/events SSE task-update stream
 *
 * The token rides `Authorization: Bearer <token>`; the per-request proof rides
 * `X-A2A-PoP` (signature) + `X-A2A-PoP-Timestamp` (ms epoch). The SIGNED
 * delegation envelope rides `X-A2A-Trace-Id` + `X-A2A-Delegation-Depth` +
 * `X-A2A-Delegation-Sig`. A plain `X-A2A-Depth` header is NEVER read — only the
 * signed value counts (plan §P8). Every decision lives in {@link A2aRpcService}
 * so the attack tests exercise it without HTTP.
 */
export function createA2aRpcRouter(opts: A2aRpcServiceOptions): Hono {
  const service = createA2aRpcService(opts);
  const router = new Hono();
  const maxBodyBytes = opts.maxBodyBytes ?? 1_000_000;

  router.post('/:personalityId', async (c) => {
    const personalityId = c.req.param('personalityId');
    const creds = readCredentials(c);

    // Body-size cap (plan T1.4 — "rate limit ≠ 200MB body"), checked BEFORE
    // `JSON.parse`. Content-Length is a fast pre-check (a peer can omit or lie
    // about it, so the actual read is capped too, not just the header).
    const contentLengthHeader = c.req.header('content-length');
    if (contentLengthHeader && Number(contentLengthHeader) > maxBodyBytes) {
      return c.json(
        errorResponse(null, RPC.PAYLOAD_TOO_LARGE, 'request body exceeds size limit'),
        413,
      );
    }

    let bodyText: string;
    try {
      bodyText = await c.req.text();
    } catch {
      return c.json(errorResponse(null, RPC.PARSE_ERROR, 'parse error'));
    }
    if (bodyText.length > maxBodyBytes) {
      return c.json(
        errorResponse(null, RPC.PAYLOAD_TOO_LARGE, 'request body exceeds size limit'),
        413,
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return c.json(errorResponse(null, RPC.PARSE_ERROR, 'parse error'));
    }

    const response = await service.handleRpc(personalityId, body, creds);
    return c.json(response);
  });

  // SSE task-update stream — authed with the same token + PoP as the RPC POST
  // (the PoP is bound to the `tasks/subscribe` pseudo-method).
  router.get('/:personalityId/tasks/:taskId/events', async (c) => {
    const personalityId = c.req.param('personalityId');
    const taskId = c.req.param('taskId');
    const taskStore = opts.taskStore;
    if (!taskStore) {
      return c.json({ error: 'NOT_SUPPORTED', message: 'async tasks are not enabled' }, 404);
    }

    const creds = readCredentials(c);

    // Pre-auth gate (plan T1.4) — same rationale as the RPC POST route: reject
    // BEFORE `authenticate()` runs any crypto.
    if (!service.checkPreAuth(creds.remoteKey ?? 'unknown')) {
      return c.json({ error: 'RATE_LIMITED', message: 'too many requests' }, 429);
    }

    // Concurrent-connection cap (plan T1.4) — a distinct resource bound from
    // the rate check above. Checked before `authenticate()` too: an attacker
    // should not be able to exhaust open-stream capacity for free either.
    const sseSlot = service.acquireSseSlot();
    if (!sseSlot) {
      return c.json({ error: 'RATE_LIMITED', message: 'too many concurrent SSE connections' }, 429);
    }

    const auth = await service.authenticate(personalityId, A2A_METHOD_TASKS_SUBSCRIBE, creds);
    if (!auth.ok) {
      sseSlot.release();
      return c.json({ error: 'REJECTED', message: auth.reason }, sseStatusFor(auth.code));
    }

    const task = await taskStore.get(taskId);
    if (!task) {
      sseSlot.release();
      return c.json({ error: 'NOT_FOUND', message: `unknown task "${taskId}"` }, 404);
    }
    // Multi-tenancy task-ownership (plan §15): a task stamped with a personality
    // is readable ONLY via that personality's SSE route — do not leak another
    // personality's task. Optional field ⇒ initiator-tracker tasks are unaffected.
    if (task.personalityId && task.personalityId !== personalityId) {
      sseSlot.release();
      return c.json({ error: 'NOT_FOUND', message: `unknown task "${taskId}"` }, 404);
    }

    return streamSSE(c, async (stream) => {
      try {
        await stream.writeSSE({ data: JSON.stringify(task) });
        if (isTerminalStatus(task.status)) return;
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            unsubscribe();
            resolve();
          };
          const unsubscribe = taskStore.subscribe(taskId, (t) => {
            void stream.writeSSE({ data: JSON.stringify(t) }).catch(() => finish());
            if (isTerminalStatus(t.status)) finish();
          });
          stream.onAbort(finish);
        });
      } finally {
        sseSlot.release();
      }
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Pull the token + PoP + SIGNED delegation off an inbound HTTP request. */
function readCredentials(c: {
  req: { header(name: string): string | undefined };
}): A2aRequestCredentials {
  const authz = c.req.header('authorization');
  const token = authz?.startsWith('Bearer ') ? authz.slice('Bearer '.length).trim() : null;
  const proofSignature = c.req.header('x-a2a-pop') ?? null;
  const tsRaw = c.req.header('x-a2a-pop-timestamp');
  const proofTimestamp = tsRaw !== undefined && /^\d+$/.test(tsRaw) ? Number(tsRaw) : null;

  const traceId = c.req.header('x-a2a-trace-id') ?? null;
  const depthRaw = c.req.header('x-a2a-delegation-depth');
  const depth = depthRaw !== undefined && /^\d+$/.test(depthRaw) ? Number(depthRaw) : null;
  const delegationSig = c.req.header('x-a2a-delegation-sig') ?? null;

  return {
    token,
    proofSignature,
    proofTimestamp,
    delegation: { traceId, depth, signature: delegationSig },
    remoteKey: remoteKeyOf(c),
    ...(c.req.header('x-a2a-claimed-fingerprint')
      ? { claimedFingerprint: c.req.header('x-a2a-claimed-fingerprint') }
      : {}),
  };
}

/**
 * Best-effort caller key for the pre-auth limiter (plan T1.4). `packages/a2a`
 * stays hono-core-only (no `@hono/node-server` dependency, unlike the apps/*
 * layer — see `apps/web-api/src/middleware/rate-limit.ts`'s `getConnInfo`
 * pattern for the socket-level equivalent), so this reads only forwarded
 * headers. TRUSTED-PROXY ASSUMPTION: `x-forwarded-for` / `x-real-ip` are
 * client-spoofable — deploying `/a2a` directly exposed (no reverse proxy in
 * front) lets a caller mint a fresh bucket per request by varying the header,
 * defeating the cap. `'unknown'` when neither header is present (e.g. direct
 * `app.request()` in tests) shares one bucket, which the default no-op
 * limiter never rejects anyway.
 */
function remoteKeyOf(c: { req: { header(name: string): string | undefined } }): string {
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  const realIp = c.req.header('x-real-ip');
  if (realIp) return realIp;
  return 'unknown';
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcErrorResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Map a JSON-RPC error code to a short audit reason label (never a body). */
function rpcReasonLabel(code: number): string {
  switch (code) {
    case RPC.UNAUTHORIZED:
      return 'unauthorized';
    case RPC.PROOF_INVALID:
      return 'proof-invalid';
    case RPC.FORBIDDEN_SCOPE:
      return 'forbidden-scope';
    case RPC.RATE_LIMITED:
      return 'rate-limited';
    case RPC.DELEGATION_REJECTED:
      return 'delegation-rejected';
    case RPC.PAYLOAD_TOO_LARGE:
      return 'payload-too-large';
    case RPC.INTERNAL:
      return 'internal-error';
    default:
      return 'denied';
  }
}

function sseStatusFor(code: number): 401 | 403 {
  return code === RPC.FORBIDDEN_SCOPE ? 403 : 401;
}

/** Peek `cnf.jkt` from an UNVERIFIED token (validateToken does the real check). */
function peekCnfJkt(token: string): string | null {
  let payload: Record<string, unknown>;
  try {
    payload = decodeJwt(token);
  } catch {
    return null;
  }
  const cnf = payload.cnf;
  if (cnf === null || typeof cnf !== 'object') return null;
  const jkt = (cnf as Record<string, unknown>).jkt;
  return typeof jkt === 'string' ? jkt : null;
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.jsonrpc === '2.0' && typeof v.method === 'string';
}

function isMessageSendParams(value: unknown): value is A2aMessageSendParams {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.skill !== 'string' || v.skill.length === 0) return false;
  if (typeof v.message !== 'string') return false;
  if (v.sessionKey !== undefined && typeof v.sessionKey !== 'string') return false;
  if (v.mode !== undefined && v.mode !== 'sync' && v.mode !== 'async') return false;
  if (v.idempotencyKey !== undefined && typeof v.idempotencyKey !== 'string') return false;
  return true;
}
