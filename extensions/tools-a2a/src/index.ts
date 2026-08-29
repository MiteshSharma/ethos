// @ethosagent/tools-a2a — the OUTBOUND A2A tool (plan §7 Phase 7 exposure).
//
// `a2a_send` lets a personality call a PEER agent. It is a thin surface over
// `@ethosagent/a2a`'s `A2aOutboundClient`: resolve MY identity + signing key for
// the ACTIVE personality, connect (fetch + verify the peer's card, handshake for
// a token), then `message/send`. When this turn is servicing an inbound A2A task
// the ambient `ctx.a2aDelegation` frame is passed straight through so the onward
// call is depth+fan-out contained by the runtime (P8) — the tool never re-implements
// any of that trust logic.
//
// Layer purity: imports ONLY `@ethosagent/types` + `@ethosagent/a2a`. No core, no apps.

import {
  A2A_RPC_AUTH_ERROR_CODES,
  type A2aAllowlist,
  A2aClientError,
  A2aOutboundClient,
  A2aOutboundError,
  type A2aSession,
} from '@ethosagent/a2a';
import type {
  A2aIdentityProvider,
  SecretsResolver,
  Tool,
  ToolContext,
  ToolResult,
} from '@ethosagent/types';
import { A2aSessionCache } from './session-cache';

export interface A2aToolDeps {
  /** Projects the active personality into a signed AgentCard (MY card). */
  identity: A2aIdentityProvider;
  /** Resolves MY Ed25519 signing key from `a2a/<personalityId>/private-key`. */
  secrets: SecretsResolver;
  /**
   * EGRESS default-deny gate (plan §15). Consulted with the VERIFIED peer
   * fingerprint before the handshake; a peer absent from this personality's
   * allowlist is refused (mirrors the inbound default-deny).
   */
  allowlist: A2aAllowlist;
  /** Injectable outbound client (tests); defaults to a fresh `A2aOutboundClient`. */
  client?: A2aOutboundClient;
  /**
   * Session/token cache (plan T1.2). Injectable so tests can share one cache
   * across calls or inspect it directly; defaults to a fresh, empty cache per
   * `createA2aTools` call (i.e. per personality wiring).
   */
  sessionCache?: A2aSessionCache;
  /**
   * Allow a personality to call its OWN agent over A2A (self-loop). Default
   * false — set via `ETHOS_A2A_SELF_LOOP=1` at the wiring layer (plan §14).
   */
  allowSelfLoop?: boolean;
  /**
   * Live A2A enablement gate. When provided and it returns false, `a2a_send`
   * short-circuits with `not_available` BEFORE touching identity/secrets/network
   * — so the tool can stay registered while A2A is disabled and start working
   * the moment it is live-enabled (no restart). When absent, assume enabled.
   */
  isEnabled?: () => boolean;
}

interface A2aSendArgs {
  peer_url: string;
  fingerprint?: string;
  skill: string;
  message: string;
  mode?: 'sync' | 'async';
}

function parseArgs(args: unknown): A2aSendArgs | null {
  if (args === null || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  if (typeof a.peer_url !== 'string' || typeof a.skill !== 'string') return null;
  if (typeof a.message !== 'string') return null;
  const mode = a.mode === 'async' ? 'async' : a.mode === 'sync' ? 'sync' : undefined;
  return {
    peer_url: a.peer_url,
    skill: a.skill,
    message: a.message,
    ...(typeof a.fingerprint === 'string' ? { fingerprint: a.fingerprint } : {}),
    ...(mode ? { mode } : {}),
  };
}

function makeA2aSendTool(deps: A2aToolDeps): Tool {
  const client = deps.client ?? new A2aOutboundClient();
  const sessionCache = deps.sessionCache ?? new A2aSessionCache();

  return {
    name: 'a2a_send',
    description:
      "Send a message to a peer agent over A2A. Give the peer's well-known Agent Card URL, the skill to invoke, and the message. Returns the peer's reply (sync) or a submission handle (async). Peering, allowlist, and tokens are handled by the runtime — you do not manage them.",
    toolset: 'a2a',
    maxResultChars: 20_000,
    capabilities: {
      // Calls an arbitrary peer-supplied URL; the outbound client handles card
      // verification + the auth handshake. Broad host reach mirrors web_extract.
      network: { allowedHosts: ['*'] },
    },
    // The peer's reply is adversary-controlled — another agent authored it.
    outputIsUntrusted: true,
    schema: {
      type: 'object',
      properties: {
        peer_url: {
          type: 'string',
          description: "The peer's /.well-known/agent-card.json URL.",
        },
        fingerprint: {
          type: 'string',
          description:
            'Optional out-of-band key fingerprint (the trust anchor from peering). When set, the fetched card must match it.',
        },
        skill: { type: 'string', description: 'The peer skill/capability to invoke.' },
        message: { type: 'string', description: 'The message to send to the peer.' },
        mode: {
          type: 'string',
          enum: ['sync', 'async'],
          description:
            "Delivery mode. 'sync' waits for the reply (default); 'async' submits and returns a handle.",
        },
      },
      required: ['peer_url', 'skill', 'message'],
    },
    async execute(rawArgs, ctx: ToolContext): Promise<ToolResult> {
      if (deps.isEnabled && !deps.isEnabled()) {
        return {
          ok: false,
          code: 'not_available',
          error: 'A2A is disabled — enable it in Settings or run `ethos a2a enable`.',
        };
      }

      const args = parseArgs(rawArgs);
      if (!args) {
        return {
          ok: false,
          error: 'peer_url, skill, and message are required strings',
          code: 'input_invalid',
        };
      }

      const personalityId = ctx.personalityId;
      if (!personalityId) {
        return {
          ok: false,
          error: 'No active personality — a2a_send needs a personality identity to sign as',
          code: 'input_invalid',
        };
      }

      const myCard = await deps.identity.getIdentity(personalityId, 'internal');
      const pem = await deps.secrets.get(`a2a/${personalityId}/private-key`);
      if (!pem) {
        return {
          ok: false,
          error: 'A2A signing key not configured for this personality',
          code: 'not_available',
        };
      }

      try {
        // T1.2: a known fingerprint (the caller's out-of-band arg, or a prior
        // successful connect at this same peer_url) lets a repeat send skip
        // the ENTIRE handshake. D13: the allowlist is re-checked on every
        // single send — cache hit or miss, before the cache is even consulted
        // — so a revoked peer fails closed even though its cached token is
        // still cryptographically valid.
        const knownFingerprint =
          args.fingerprint ?? sessionCache.resolveFingerprint(personalityId, args.peer_url);

        let session: A2aSession | null = null;
        if (knownFingerprint) {
          const grant = await deps.allowlist.lookup(personalityId, knownFingerprint);
          if (!grant) {
            sessionCache.invalidate(personalityId, knownFingerprint);
            throw new A2aOutboundError(
              'egress_denied',
              `peer ${knownFingerprint} is not on this personality's A2A egress allowlist (default-deny) — approve it out-of-band before calling it.`,
            );
          }
          session = sessionCache.get(personalityId, knownFingerprint);
        }

        if (!session) {
          // Cache MISS — the full handshake, which re-verifies the card's
          // signature and fingerprint in full (never trust a cached card past
          // its token's life; only a HIT skips this).
          session = await client.connect({
            wellKnownUrl: args.peer_url,
            ...(args.fingerprint ? { expectedFingerprint: args.fingerprint } : {}),
            myCard,
            myPrivateKeyPem: pem,
            ...(deps.allowSelfLoop ? { allowSelfLoop: true } : {}),
            // Egress default-deny: refuse a peer that is not on this personality's
            // allowlist BEFORE the handshake (no challenge, no card, no token).
            // Redundant with the pre-check above when `knownFingerprint` was
            // set — cheap, and the only guard at all for a first-ever call to
            // a peer_url with no prior fingerprint.
            egressCheck: (fp) => deps.allowlist.lookup(personalityId, fp).then((g) => g !== null),
          });
          sessionCache.set(personalityId, args.peer_url, session);
        }

        // Ambient inbound trace (P8) — already the {traceId, depth, reserveOutbound}
        // shape the client expects. Absent → a fresh top-level call.
        const delegation = ctx.a2aDelegation;

        const result = await client.sendMessage({
          session,
          myPrivateKeyPem: pem,
          skill: args.skill,
          message: args.message,
          ...(args.mode ? { mode: args.mode } : {}),
          ...(delegation ? { delegation } : {}),
        });

        if (!result.ok) {
          // T1.2: the PEER rejected my token/proof — the cached session is no
          // longer good. Evict it so the NEXT send re-handshakes rather than
          // repeating a doomed request every time.
          if (
            result.code === A2A_RPC_AUTH_ERROR_CODES.UNAUTHORIZED ||
            result.code === A2A_RPC_AUTH_ERROR_CODES.PROOF_INVALID
          ) {
            sessionCache.invalidate(personalityId, session.peerCard.keyFingerprint);
          }
          return {
            ok: false,
            error: `${result.code}: ${result.message}`,
            code: 'execution_failed',
          };
        }

        if (result.mode === 'async') {
          return {
            ok: true,
            value: `Submitted to peer (async). Task ${result.taskId} is ${result.status}.`,
            structured: { ...result },
          };
        }

        return {
          ok: true,
          value: result.text,
          structured: { ...result },
        };
      } catch (err) {
        if (err instanceof A2aOutboundError) {
          if (err.code === 'fanout_exhausted') {
            return {
              ok: false,
              error:
                'A2A fan-out budget exhausted for this task — refusing further outbound calls (delegation containment).',
              code: 'execution_failed',
            };
          }
          if (err.code === 'self_loop_forbidden') {
            return {
              ok: false,
              error:
                'A2A self-loop is disabled (set ETHOS_A2A_SELF_LOOP=1 to allow calling your own agent).',
              code: 'execution_failed',
            };
          }
          if (err.code === 'egress_denied') {
            return {
              ok: false,
              error:
                "peer is not on this personality's A2A egress allowlist (default-deny) — approve it out-of-band before calling it.",
              code: 'execution_failed',
            };
          }
          return { ok: false, error: err.message, code: 'execution_failed' };
        }
        if (err instanceof A2aClientError) {
          return { ok: false, error: `${err.code}: ${err.message}`, code: 'execution_failed' };
        }
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'execution_failed',
        };
      }
    },
  };
}

/** Build the outbound A2A toolset. Register only when A2A is enabled (opt-in). */
export function createA2aTools(deps: A2aToolDeps): Tool[] {
  return [makeA2aSendTool(deps)];
}
