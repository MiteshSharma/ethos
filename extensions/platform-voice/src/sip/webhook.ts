// Inbound SIP webhook — signature verification and payload parsing.
//
// The webhook is the ONLY unauthenticated door telephony opens into a
// deployment: anyone who learns the URL can otherwise ring the agent, burn
// provider minutes and reach whatever the receptionist scope reaches. So this
// module verifies before anything downstream sees a call, and every scheme
// fails CLOSED — an unrecognised provider, a missing header and a malformed
// timestamp are all refusals, never a pass-through.
//
// Four schemes, because the four providers genuinely differ: LiveKit signs a
// JWT that commits to a body hash, Twilio signs the URL plus sorted form
// params with HMAC-SHA1, Telnyx signs `timestamp|body` with Ed25519, and
// `generic` is the Stripe-shaped HMAC-SHA256 an operator can implement in
// front of any trunk. Every comparison is length-guarded then `timingSafeEqual`
// (the idiom from apps/ethos/src/webhook-server.ts).
//
// Reasons are DISTINCT per failure category — an operator staring at a 401
// needs to know whether the header was missing, the signature was wrong, the
// timestamp was stale or the provider name was unknown. They never carry the
// secret or the received signature: a reason string ends up in a log, and a log
// is not a place to put either half of a credential comparison.

import type { KeyObject } from 'node:crypto';
import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { hs256Base64Url } from '../livekit/token';
import type { InboundSipCall } from './trunk-client';

/** Replay window for the schemes that carry a timestamp. */
const DEFAULT_TOLERANCE_MS = 300_000;

/** DER SPKI prefix for a raw 32-byte Ed25519 public key (Telnyx ships raw). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export type SipWebhookProvider = 'twilio' | 'telnyx' | 'livekit' | 'generic';

export interface VerifyWebhookInput {
  provider: SipWebhookProvider;
  /** Shared secret / auth token / base64 Ed25519 public key, per provider. */
  secret: string;
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  /** Full request URL — Twilio signs it. */
  url?: string;
  now?: () => number;
  /** Replay window, default 300_000 ms. */
  toleranceMs?: number;
}

export type VerifyWebhookResult = { ok: true } | { ok: false; reason: string };

const MISSING_SIGNATURE = 'missing_signature_header';
const MISSING_TIMESTAMP = 'missing_timestamp_header';
const MISSING_URL = 'missing_request_url';
const MALFORMED_SIGNATURE = 'malformed_signature_header';
const MALFORMED_TIMESTAMP = 'malformed_timestamp';
const INVALID_SIGNATURE = 'invalid_signature';
const STALE_TIMESTAMP = 'stale_timestamp';
const EXPIRED_TOKEN = 'expired_token';
const BODY_HASH_MISMATCH = 'body_hash_mismatch';
const INVALID_PUBLIC_KEY = 'invalid_public_key';
const UNKNOWN_PROVIDER = 'unknown_provider';

const fail = (reason: string): VerifyWebhookResult => ({ ok: false, reason });

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === 'string' && first.length > 0 ? first : null;
  }
  return null;
}

/** Length-guarded constant-time compare — `timingSafeEqual` throws on a length
 *  mismatch, so the guard is required, not defensive. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Seconds-since-epoch timestamp within the replay window, or a reason. */
function checkTimestamp(raw: string, nowMs: number, toleranceMs: number): string | null {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) return MALFORMED_TIMESTAMP;
  if (Math.abs(nowMs - seconds * 1000) > toleranceMs) return STALE_TIMESTAMP;
  return null;
}

function verifyLiveKit(input: VerifyWebhookInput, nowMs: number): VerifyWebhookResult {
  const authorization = headerValue(input.headers, 'authorization');
  if (!authorization) return fail(MISSING_SIGNATURE);
  const token = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : authorization.trim();

  const parts = token.split('.');
  const [encodedHeader, encodedPayload, signature] = parts;
  if (parts.length !== 3 || !encodedHeader || !encodedPayload || !signature) {
    return fail(MALFORMED_SIGNATURE);
  }
  if (!safeEqual(hs256Base64Url(`${encodedHeader}.${encodedPayload}`, input.secret), signature)) {
    return fail(INVALID_SIGNATURE);
  }

  let claims: Record<string, unknown>;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    const record = asRecord(decoded);
    if (!record) return fail(MALFORMED_SIGNATURE);
    claims = record;
  } catch {
    return fail(MALFORMED_SIGNATURE);
  }

  // A token with no `exp` is treated as expired: an unbounded webhook token is
  // a replay primitive, and failing closed costs an operator one config fix.
  const exp = claims.exp;
  if (typeof exp !== 'number' || nowMs / 1000 > exp) return fail(EXPIRED_TOKEN);

  const bodyHash = claims.sha256;
  if (typeof bodyHash !== 'string') return fail(BODY_HASH_MISMATCH);
  const actual = createHash('sha256').update(input.rawBody, 'utf8').digest('base64');
  if (!safeEqual(actual, bodyHash)) return fail(BODY_HASH_MISMATCH);
  return { ok: true };
}

function verifyTwilio(input: VerifyWebhookInput): VerifyWebhookResult {
  const signature = headerValue(input.headers, 'x-twilio-signature');
  if (!signature) return fail(MISSING_SIGNATURE);
  if (!input.url) return fail(MISSING_URL);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(input.url);
  } catch {
    return fail(MISSING_URL);
  }

  // Twilio signs the URL plus the sorted form params. For a JSON body there are
  // no params to sort, so it commits to the body through a `bodySHA256` query
  // param that is already inside the signed URL — verify that hash too, or the
  // body is unauthenticated while the signature still checks out.
  const bodyHash = parsedUrl.searchParams.get('bodySHA256');
  let base = input.url;
  if (bodyHash === null) {
    const params = new URLSearchParams(input.rawBody);
    for (const key of [...new Set(params.keys())].sort()) {
      base += key + (params.get(key) ?? '');
    }
  } else {
    const actual = createHash('sha256').update(input.rawBody, 'utf8').digest('hex');
    if (!safeEqual(actual, bodyHash)) return fail(BODY_HASH_MISMATCH);
  }

  const expected = createHmac('sha1', input.secret).update(base, 'utf8').digest('base64');
  return safeEqual(expected, signature) ? { ok: true } : fail(INVALID_SIGNATURE);
}

function ed25519PublicKey(secret: string): KeyObject | null {
  try {
    if (secret.includes('-----BEGIN')) return createPublicKey(secret);
    const raw = Buffer.from(secret, 'base64');
    if (raw.length !== 32) return null;
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return null;
  }
}

function verifyTelnyx(
  input: VerifyWebhookInput,
  nowMs: number,
  toleranceMs: number,
): VerifyWebhookResult {
  const signature = headerValue(input.headers, 'telnyx-signature-ed25519');
  if (!signature) return fail(MISSING_SIGNATURE);
  const timestamp = headerValue(input.headers, 'telnyx-timestamp');
  if (!timestamp) return fail(MISSING_TIMESTAMP);
  const timestampFailure = checkTimestamp(timestamp, nowMs, toleranceMs);
  if (timestampFailure) return fail(timestampFailure);

  const key = ed25519PublicKey(input.secret);
  if (!key) return fail(INVALID_PUBLIC_KEY);

  // Ed25519 takes NO digest algorithm — `verify('ed25519', …)` throws
  // `Invalid digest`. The algorithm argument must be null.
  const signed = Buffer.from(`${timestamp}|${input.rawBody}`, 'utf8');
  const decoded = Buffer.from(signature, 'base64');
  try {
    return verify(null, signed, key, decoded) ? { ok: true } : fail(INVALID_SIGNATURE);
  } catch {
    return fail(INVALID_SIGNATURE);
  }
}

function verifyGeneric(
  input: VerifyWebhookInput,
  nowMs: number,
  toleranceMs: number,
): VerifyWebhookResult {
  const header = headerValue(input.headers, 'x-ethos-signature');
  if (!header) return fail(MISSING_SIGNATURE);

  // Two accepted shapes: a bare hex digest, or the Stripe-style
  // `t=<ts>,v1=<hex>`. A hex digest contains no `=`, so the discriminator is
  // unambiguous.
  let signature = header.trim();
  let timestamp: string | null = null;
  if (header.includes('=')) {
    const fields = new Map<string, string>();
    for (const part of header.split(',')) {
      const index = part.indexOf('=');
      if (index > 0) fields.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
    }
    const v1 = fields.get('v1');
    if (!v1) return fail(MALFORMED_SIGNATURE);
    signature = v1;
    timestamp = fields.get('t') ?? null;
  }
  timestamp = timestamp ?? headerValue(input.headers, 'x-ethos-timestamp');
  if (!timestamp) return fail(MISSING_TIMESTAMP);

  const timestampFailure = checkTimestamp(timestamp, nowMs, toleranceMs);
  if (timestampFailure) return fail(timestampFailure);

  const expected = createHmac('sha256', input.secret)
    .update(`${timestamp}.${input.rawBody}`, 'utf8')
    .digest('hex');
  return safeEqual(expected, signature) ? { ok: true } : fail(INVALID_SIGNATURE);
}

/**
 * Verify an inbound SIP webhook. Returns `{ ok: true }` only when the request
 * provably came from the configured provider; every other outcome names WHICH
 * check refused it, without echoing the secret or the received signature.
 *
 * Note the one honest gap: Twilio's scheme carries no timestamp, so no replay
 * window can be enforced for it. Rotate the auth token and terminate TLS
 * yourself rather than assuming a window that does not exist.
 */
export function verifySipWebhook(input: VerifyWebhookInput): VerifyWebhookResult {
  const nowMs = input.now ? input.now() : Date.now();
  const toleranceMs = input.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  switch (input.provider) {
    case 'livekit':
      return verifyLiveKit(input, nowMs);
    case 'twilio':
      return verifyTwilio(input);
    case 'telnyx':
      return verifyTelnyx(input, nowMs, toleranceMs);
    case 'generic':
      return verifyGeneric(input, nowMs, toleranceMs);
  }
  // Unreachable for a typed caller; reached when the provider came from config.
  return fail(UNKNOWN_PROVIDER);
}

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(record: Record<string, unknown> | null, key: string): string | null {
  if (!record) return null;
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Room name when the provider does not supply one. Deterministic in both
 * numbers, so a retried webhook for the same call lands in the SAME room rather
 * than bridging a second leg beside the first.
 */
function fallbackRoomName(toNumber: string, fromNumber: string): string {
  const digits = (value: string): string => value.replace(/\D/g, '');
  return `call-${digits(toNumber)}-${digits(fromNumber)}`;
}

function parseTwilio(record: Record<string, unknown>): InboundSipCall | null {
  // `CallSid` is what makes it a CALL — an SMS webhook carries From/To too.
  if (!str(record, 'CallSid')) return null;
  const fromNumber = str(record, 'From');
  const toNumber = str(record, 'To');
  if (!fromNumber || !toNumber) return null;
  return { fromNumber, toNumber, roomName: fallbackRoomName(toNumber, fromNumber) };
}

function parseTelnyx(record: Record<string, unknown>): InboundSipCall | null {
  const data = asRecord(record.data);
  const eventType = str(data, 'event_type') ?? str(record, 'event_type');
  if (eventType && !eventType.startsWith('call.')) return null;
  const payload = asRecord(data?.payload) ?? asRecord(record.payload);
  const fromNumber = str(payload, 'from');
  const toNumber = str(payload, 'to');
  if (!fromNumber || !toNumber) return null;
  return {
    fromNumber,
    toNumber,
    roomName: str(payload, 'room') ?? fallbackRoomName(toNumber, fromNumber),
  };
}

function parseLiveKit(record: Record<string, unknown>): InboundSipCall | null {
  const participant = asRecord(record.participant);
  const attributes = asRecord(participant?.attributes);
  const fromNumber = str(attributes, 'sip.phoneNumber');
  const toNumber = str(attributes, 'sip.trunkPhoneNumber');
  if (!fromNumber || !toNumber) return null;
  return {
    fromNumber,
    toNumber,
    roomName: str(asRecord(record.room), 'name') ?? fallbackRoomName(toNumber, fromNumber),
  };
}

function parseGeneric(record: Record<string, unknown>): InboundSipCall | null {
  const fromNumber = str(record, 'from');
  const toNumber = str(record, 'to');
  if (!fromNumber || !toNumber) return null;
  return {
    fromNumber,
    toNumber,
    roomName: str(record, 'room') ?? fallbackRoomName(toNumber, fromNumber),
  };
}

/**
 * Map a verified webhook payload to an {@link InboundSipCall}, or `null` when
 * the payload is not a call event or is missing the fields dispatch needs.
 * NEVER throws: a provider that adds a field, renames an event or posts an
 * unrelated webhook must produce a refusal, not a crashed listener.
 */
export function parseInboundSipCall(
  provider: SipWebhookProvider,
  body: unknown,
): InboundSipCall | null {
  const record = asRecord(body);
  if (!record) return null;
  switch (provider) {
    case 'twilio':
      return parseTwilio(record);
    case 'telnyx':
      return parseTelnyx(record);
    case 'livekit':
      return parseLiveKit(record);
    case 'generic':
      return parseGeneric(record);
  }
  return null;
}
