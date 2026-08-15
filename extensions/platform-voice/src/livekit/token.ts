// LiveKit access tokens — the real, zero-dependency implementation of the
// LiveKitTokenMinter boundary (voice V4).
//
// A LiveKit access token is an ordinary HS256 JWT signed with the project
// apiKey/apiSecret; `livekit-server-sdk`'s `AccessToken` adds nothing this repo
// needs beyond the signature. Minting it here with `node:crypto` is what makes
// `voice.livekit.apiKey` / `apiSecret` reachable at all — until now they were
// parsed by `@ethosagent/config` and read by nothing — WITHOUT pulling the
// server SDK into the dependency graph. The media leg still needs the
// app-supplied `@livekit/rtc-node` binding; only the token half is solved here.

import { createHmac } from 'node:crypto';
import type { LiveKitTokenMinter } from './room-client';

/** Default token lifetime. LiveKit's own default; a call outlives a short TTL. */
const DEFAULT_TTL_SECONDS = 3600;

/**
 * Backdate `nbf` so a token stays valid across small clock skew between this
 * process and the LiveKit server. Ten seconds is LiveKit's own leeway.
 */
const NBF_SKEW_SECONDS = 10;

export interface LiveKitTokenMinterOptions {
  apiKey: string;
  apiSecret: string;
  /** Token lifetime in seconds. Default 3600. */
  ttlSeconds?: number;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
}

export interface LiveKitSipJwtOptions extends LiveKitTokenMinterOptions {
  /** Room the SIP participant is created into — the grant is room-scoped. */
  roomName: string;
}

/**
 * HS256 signature (base64url, unpadded) over a JWT signing input. Exported so
 * `sip/webhook.ts` can VERIFY a LiveKit-signed webhook JWT against the exact
 * scheme used to mint one — the signer and the verifier must never drift apart.
 * Not part of the package's public surface.
 */
export function hs256Base64Url(signingInput: string, secret: string): string {
  return createHmac('sha256', secret).update(signingInput).digest('base64url');
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** The one signer. Every token this package mints goes through here. */
function signLiveKitJwt(
  opts: LiveKitTokenMinterOptions,
  identity: string,
  grants: Record<string, unknown>,
): string {
  const nowSeconds = Math.floor((opts.now ? opts.now() : Date.now()) / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: opts.apiKey,
    sub: opts.apiKey,
    nbf: nowSeconds - NBF_SKEW_SECONDS,
    exp: nowSeconds + (opts.ttlSeconds ?? DEFAULT_TTL_SECONDS),
    identity,
    ...grants,
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  return `${signingInput}.${hs256Base64Url(signingInput, opts.apiSecret)}`;
}

/**
 * A {@link LiveKitTokenMinter} that signs room-join tokens locally. Drop-in for
 * the interface `LiveKitVoiceTransport` already consumes, so wiring it changes
 * nothing downstream.
 */
export function createLiveKitTokenMinter(opts: LiveKitTokenMinterOptions): LiveKitTokenMinter {
  return {
    mint(roomName: string, identity: string): string {
      return signLiveKitJwt(opts, identity, {
        video: { roomJoin: true, room: roomName, canPublish: true, canSubscribe: true },
      });
    },
  };
}

/**
 * A token carrying the extra `sip: { call: true }` grant LiveKit's SIP API
 * requires on `CreateSIPParticipant`. Same signer, one more grant — a room-join
 * token is rejected by the SIP endpoint, and a SIP token is not something the
 * media transport should be handed.
 */
export function createLiveKitSipJwt(opts: LiveKitSipJwtOptions): string {
  return signLiveKitJwt(opts, opts.apiKey, {
    video: { roomJoin: true, room: opts.roomName, canPublish: true, canSubscribe: true },
    sip: { call: true },
  });
}
