// The production SipTrunkClient — LiveKit's SIP control plane over plain HTTPS.
//
// LiveKit's SIP API is Twirp: a JSON POST to
// `/twirp/livekit.SIP/CreateSIPParticipant` authorized by a signed JWT carrying
// the `sip: { call: true }` grant. There is no media, no native binary and no
// SDK in that path — `livekit-server-sdk` would contribute a request builder we
// can write in thirty lines. So the control plane binds directly here, while
// the room MEDIA leg keeps the app-supplied `@livekit/rtc-node` boundary
// (see `../livekit/room-client.ts`).
//
// This is an ADDITIONAL binding, not a replacement: `SipTrunkClient` stays the
// interface every caller depends on, and `FakeSipTrunkClient` stays the unit
// test path.

import { createLiveKitSipJwt } from '../livekit/token';
import type { OutboundCallHandle, OutboundCallRequest, SipTrunkClient } from './trunk-client';

const DEFAULT_TIMEOUT_MS = 15_000;

/** Upper bound on how much of a provider's refusal body reaches a log line. */
const MAX_ERROR_BODY_CHARS = 300;

export interface LiveKitSipTrunkOptions {
  /** LiveKit server URL — accepts ws:// / wss:// and normalizes to http(s). */
  url: string;
  apiKey: string;
  apiSecret: string;
  /** `voice.trunk.trunkId` — the LiveKit SIP outbound trunk. */
  trunkId: string;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** Request timeout ms, default 15_000. */
  timeoutMs?: number;
}

/**
 * `wss://host` -> `https://host`, `ws://host` -> `http://host`, trailing
 * slashes stripped. The same URL configures the media transport (a WebSocket)
 * and this control plane (HTTPS), so one of the two has to translate.
 */
function toHttpUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed.startsWith('wss://')) return `https://${trimmed.slice('wss://'.length)}`;
  if (trimmed.startsWith('ws://')) return `http://${trimmed.slice('ws://'.length)}`;
  return trimmed;
}

/**
 * Strip operator credentials out of a provider's response body before it can
 * reach a log. A refusal that echoes the request (some proxies do) would
 * otherwise carry the bearer token — and the token is minted from the
 * apiSecret, so leaking it leaks the ability to place calls. The known literals
 * go first; the generic `Bearer …` / JWT patterns catch a credential this
 * process did not mint. Redaction runs BEFORE truncation so a cut in the middle
 * of a token cannot leave a matched-nothing prefix behind.
 */
function redactAndTruncate(body: string, secrets: readonly string[]): string {
  let out = body;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join('[redacted]');
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
  out = out.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]');
  return out.length > MAX_ERROR_BODY_CHARS ? `${out.slice(0, MAX_ERROR_BODY_CHARS)}…` : out;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * A {@link SipTrunkClient} backed by LiveKit's SIP HTTP API. Every failure —
 * non-2xx, timeout, malformed body — throws with the fact an operator needs and
 * without the credential they must not see in a log.
 */
export function createLiveKitSipTrunkClient(opts: LiveKitSipTrunkOptions): SipTrunkClient {
  const endpoint = `${toHttpUrl(opts.url)}/twirp/livekit.SIP/CreateSIPParticipant`;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async createOutboundCall(req: OutboundCallRequest): Promise<OutboundCallHandle> {
      const token = createLiveKitSipJwt({
        apiKey: opts.apiKey,
        apiSecret: opts.apiSecret,
        roomName: req.roomName,
        ...(opts.now ? { now: opts.now } : {}),
      });
      const secrets = [opts.apiSecret, token];
      const body = {
        sip_trunk_id: opts.trunkId,
        sip_call_to: req.toNumber,
        room_name: req.roomName,
        participant_identity: req.participantIdentity ?? req.toNumber,
        participant_name: req.toNumber,
        ...(req.fromNumber ? { sip_number: req.fromNumber } : {}),
      };

      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (isAbortError(err)) {
          throw new Error(`LiveKit SIP CreateSIPParticipant timed out after ${timeoutMs}ms`);
        }
        throw err;
      }

      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `LiveKit SIP CreateSIPParticipant failed: ${response.status} ${redactAndTruncate(text, secrets)}`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(
          `LiveKit SIP CreateSIPParticipant returned a non-JSON body: ${redactAndTruncate(text, secrets)}`,
        );
      }

      const record = asRecord(parsed);
      const callId = record
        ? (stringField(record, 'sip_call_id') ?? stringField(record, 'participant_id'))
        : null;
      if (!callId) {
        throw new Error(
          'LiveKit SIP CreateSIPParticipant returned no sip_call_id or participant_id',
        );
      }
      return { callId, roomName: req.roomName, toNumber: req.toNumber };
    },
  };
}
