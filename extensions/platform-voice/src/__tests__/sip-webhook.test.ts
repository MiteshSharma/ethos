import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hs256Base64Url } from '../livekit/token';
import {
  parseInboundSipCall,
  type SipWebhookProvider,
  type VerifyWebhookResult,
  verifySipWebhook,
} from '../sip/webhook';

const NOW_MS = 1_700_000_000_000;
const NOW_SECONDS = NOW_MS / 1000;
const now = () => NOW_MS;

const SECRET = 'shared-webhook-secret-value';

// --- LiveKit ---------------------------------------------------------------

function livekitToken(
  secret: string,
  body: string,
  opts: { exp?: number; sha256?: string } = {},
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'devkey',
      exp: opts.exp ?? NOW_SECONDS + 60,
      sha256: opts.sha256 ?? createHash('sha256').update(body, 'utf8').digest('base64'),
    }),
  ).toString('base64url');
  return `${header}.${payload}.${hs256Base64Url(`${header}.${payload}`, secret)}`;
}

describe('verifySipWebhook — livekit', () => {
  const body = JSON.stringify({ event: 'participant_joined' });

  it('accepts a correctly signed token whose sha256 claim matches the body', () => {
    expect(
      verifySipWebhook({
        provider: 'livekit',
        secret: SECRET,
        rawBody: body,
        headers: { authorization: `Bearer ${livekitToken(SECRET, body)}` },
        now,
      }),
    ).toEqual({ ok: true });
  });

  it('refuses a tampered body — the signature still checks, the body hash does not', () => {
    expect(
      verifySipWebhook({
        provider: 'livekit',
        secret: SECRET,
        rawBody: `${body} tampered`,
        headers: { Authorization: `Bearer ${livekitToken(SECRET, body)}` },
        now,
      }),
    ).toEqual({ ok: false, reason: 'body_hash_mismatch' });
  });

  it('refuses a token signed with the wrong secret', () => {
    expect(
      verifySipWebhook({
        provider: 'livekit',
        secret: SECRET,
        rawBody: body,
        headers: { authorization: `Bearer ${livekitToken('other-secret', body)}` },
        now,
      }),
    ).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('refuses an expired token', () => {
    expect(
      verifySipWebhook({
        provider: 'livekit',
        secret: SECRET,
        rawBody: body,
        headers: {
          authorization: `Bearer ${livekitToken(SECRET, body, { exp: NOW_SECONDS - 1 })}`,
        },
        now,
      }),
    ).toEqual({ ok: false, reason: 'expired_token' });
  });

  it('refuses a missing Authorization header', () => {
    expect(
      verifySipWebhook({ provider: 'livekit', secret: SECRET, rawBody: body, headers: {}, now }),
    ).toEqual({ ok: false, reason: 'missing_signature_header' });
  });

  it('refuses a token that is not three segments', () => {
    expect(
      verifySipWebhook({
        provider: 'livekit',
        secret: SECRET,
        rawBody: body,
        headers: { authorization: 'Bearer not-a-jwt' },
        now,
      }),
    ).toEqual({ ok: false, reason: 'malformed_signature_header' });
  });
});

// --- Twilio ----------------------------------------------------------------

function twilioSignature(secret: string, url: string, params: Record<string, string>): string {
  let base = url;
  for (const key of Object.keys(params).sort()) base += key + (params[key] ?? '');
  return createHmac('sha1', secret).update(base, 'utf8').digest('base64');
}

describe('verifySipWebhook — twilio', () => {
  const url = 'https://hooks.example.com/voice';
  const params = { CallSid: 'CA123', From: '+15551234567', To: '+15550000001' };
  const rawBody = new URLSearchParams(params).toString();

  it('accepts a form-encoded body signed over url + sorted params', () => {
    expect(
      verifySipWebhook({
        provider: 'twilio',
        secret: SECRET,
        rawBody,
        url,
        headers: { 'x-twilio-signature': twilioSignature(SECRET, url, params) },
        now,
      }),
    ).toEqual({ ok: true });
  });

  it('refuses a tampered body', () => {
    expect(
      verifySipWebhook({
        provider: 'twilio',
        secret: SECRET,
        rawBody: new URLSearchParams({ ...params, From: '+19998887777' }).toString(),
        url,
        headers: { 'X-Twilio-Signature': twilioSignature(SECRET, url, params) },
        now,
      }),
    ).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('refuses a signature made with the wrong secret', () => {
    expect(
      verifySipWebhook({
        provider: 'twilio',
        secret: SECRET,
        rawBody,
        url,
        headers: { 'x-twilio-signature': twilioSignature('other-secret', url, params) },
        now,
      }),
    ).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  // Twilio's scheme carries NO timestamp, so no replay window exists to
  // enforce. This test pins the gap so nobody assumes a protection that is not
  // there: rotate the auth token instead of relying on expiry.
  it('has no replay window — a stale request still verifies', () => {
    expect(
      verifySipWebhook({
        provider: 'twilio',
        secret: SECRET,
        rawBody,
        url,
        headers: { 'x-twilio-signature': twilioSignature(SECRET, url, params) },
        now: () => NOW_MS + 86_400_000,
      }),
    ).toEqual({ ok: true });
  });

  it('refuses a missing signature header', () => {
    expect(
      verifySipWebhook({ provider: 'twilio', secret: SECRET, rawBody, url, headers: {}, now }),
    ).toEqual({ ok: false, reason: 'missing_signature_header' });
  });

  it('refuses when no request URL was supplied — Twilio signs it', () => {
    expect(
      verifySipWebhook({
        provider: 'twilio',
        secret: SECRET,
        rawBody,
        headers: { 'x-twilio-signature': twilioSignature(SECRET, url, params) },
        now,
      }),
    ).toEqual({ ok: false, reason: 'missing_request_url' });
  });

  it('verifies the bodySHA256 query param for a JSON body', () => {
    const jsonBody = JSON.stringify({ CallSid: 'CA123' });
    const hash = createHash('sha256').update(jsonBody, 'utf8').digest('hex');
    const jsonUrl = `${url}?bodySHA256=${hash}`;
    const signature = createHmac('sha1', SECRET).update(jsonUrl, 'utf8').digest('base64');

    expect(
      verifySipWebhook({
        provider: 'twilio',
        secret: SECRET,
        rawBody: jsonBody,
        url: jsonUrl,
        headers: { 'x-twilio-signature': signature },
        now,
      }),
    ).toEqual({ ok: true });

    // Same signed URL, different body — the signature alone would pass.
    expect(
      verifySipWebhook({
        provider: 'twilio',
        secret: SECRET,
        rawBody: `${jsonBody} tampered`,
        url: jsonUrl,
        headers: { 'x-twilio-signature': signature },
        now,
      }),
    ).toEqual({ ok: false, reason: 'body_hash_mismatch' });
  });
});

// --- Telnyx ----------------------------------------------------------------

const telnyxKeys = generateKeyPairSync('ed25519');
const TELNYX_PUBLIC_KEY = Buffer.from(telnyxKeys.publicKey.export({ format: 'der', type: 'spki' }))
  .subarray(12)
  .toString('base64');

function telnyxSignature(body: string, timestamp: string): string {
  return sign(null, Buffer.from(`${timestamp}|${body}`, 'utf8'), telnyxKeys.privateKey).toString(
    'base64',
  );
}

describe('verifySipWebhook — telnyx', () => {
  const rawBody = JSON.stringify({ data: { event_type: 'call.initiated' } });
  const timestamp = String(NOW_SECONDS);

  it('accepts a real Ed25519 signature over `timestamp|body`', () => {
    expect(
      verifySipWebhook({
        provider: 'telnyx',
        secret: TELNYX_PUBLIC_KEY,
        rawBody,
        headers: {
          'telnyx-signature-ed25519': telnyxSignature(rawBody, timestamp),
          'telnyx-timestamp': timestamp,
        },
        now,
      }),
    ).toEqual({ ok: true });
  });

  it('refuses a tampered body', () => {
    expect(
      verifySipWebhook({
        provider: 'telnyx',
        secret: TELNYX_PUBLIC_KEY,
        rawBody: `${rawBody} tampered`,
        headers: {
          'telnyx-signature-ed25519': telnyxSignature(rawBody, timestamp),
          'telnyx-timestamp': timestamp,
        },
        now,
      }),
    ).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('refuses a signature checked against the wrong public key', () => {
    const other = generateKeyPairSync('ed25519');
    const otherPublic = Buffer.from(other.publicKey.export({ format: 'der', type: 'spki' }))
      .subarray(12)
      .toString('base64');
    expect(
      verifySipWebhook({
        provider: 'telnyx',
        secret: otherPublic,
        rawBody,
        headers: {
          'telnyx-signature-ed25519': telnyxSignature(rawBody, timestamp),
          'telnyx-timestamp': timestamp,
        },
        now,
      }),
    ).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('refuses a timestamp outside the replay window', () => {
    const stale = String(NOW_SECONDS - 600);
    expect(
      verifySipWebhook({
        provider: 'telnyx',
        secret: TELNYX_PUBLIC_KEY,
        rawBody,
        headers: {
          'telnyx-signature-ed25519': telnyxSignature(rawBody, stale),
          'telnyx-timestamp': stale,
        },
        now,
      }),
    ).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('refuses missing signature and missing timestamp headers distinctly', () => {
    expect(
      verifySipWebhook({
        provider: 'telnyx',
        secret: TELNYX_PUBLIC_KEY,
        rawBody,
        headers: { 'telnyx-timestamp': timestamp },
        now,
      }),
    ).toEqual({ ok: false, reason: 'missing_signature_header' });

    expect(
      verifySipWebhook({
        provider: 'telnyx',
        secret: TELNYX_PUBLIC_KEY,
        rawBody,
        headers: { 'telnyx-signature-ed25519': telnyxSignature(rawBody, timestamp) },
        now,
      }),
    ).toEqual({ ok: false, reason: 'missing_timestamp_header' });
  });

  it('refuses a public key that is not a 32-byte Ed25519 key', () => {
    expect(
      verifySipWebhook({
        provider: 'telnyx',
        secret: 'bm90LWEta2V5',
        rawBody,
        headers: {
          'telnyx-signature-ed25519': telnyxSignature(rawBody, timestamp),
          'telnyx-timestamp': timestamp,
        },
        now,
      }),
    ).toEqual({ ok: false, reason: 'invalid_public_key' });
  });
});

// --- Generic ---------------------------------------------------------------

function genericSignature(secret: string, body: string, timestamp: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
}

describe('verifySipWebhook — generic', () => {
  const rawBody = JSON.stringify({ from: '+1555', to: '+1666' });
  const timestamp = String(NOW_SECONDS);

  it('accepts the bare-hex form with a separate timestamp header', () => {
    expect(
      verifySipWebhook({
        provider: 'generic',
        secret: SECRET,
        rawBody,
        headers: {
          'x-ethos-signature': genericSignature(SECRET, rawBody, timestamp),
          'x-ethos-timestamp': timestamp,
        },
        now,
      }),
    ).toEqual({ ok: true });
  });

  it('accepts the t=,v1= form', () => {
    expect(
      verifySipWebhook({
        provider: 'generic',
        secret: SECRET,
        rawBody,
        headers: {
          'x-ethos-signature': `t=${timestamp},v1=${genericSignature(SECRET, rawBody, timestamp)}`,
        },
        now,
      }),
    ).toEqual({ ok: true });
  });

  it('refuses a tampered body', () => {
    expect(
      verifySipWebhook({
        provider: 'generic',
        secret: SECRET,
        rawBody: `${rawBody} tampered`,
        headers: {
          'x-ethos-signature': `t=${timestamp},v1=${genericSignature(SECRET, rawBody, timestamp)}`,
        },
        now,
      }),
    ).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('refuses a signature made with the wrong secret', () => {
    expect(
      verifySipWebhook({
        provider: 'generic',
        secret: SECRET,
        rawBody,
        headers: {
          'x-ethos-signature': `t=${timestamp},v1=${genericSignature('other', rawBody, timestamp)}`,
        },
        now,
      }),
    ).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('refuses a timestamp outside the replay window', () => {
    const stale = String(NOW_SECONDS - 600);
    expect(
      verifySipWebhook({
        provider: 'generic',
        secret: SECRET,
        rawBody,
        headers: {
          'x-ethos-signature': `t=${stale},v1=${genericSignature(SECRET, rawBody, stale)}`,
        },
        now,
      }),
    ).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('refuses missing signature and missing timestamp headers distinctly', () => {
    expect(
      verifySipWebhook({ provider: 'generic', secret: SECRET, rawBody, headers: {}, now }),
    ).toEqual({ ok: false, reason: 'missing_signature_header' });

    expect(
      verifySipWebhook({
        provider: 'generic',
        secret: SECRET,
        rawBody,
        headers: { 'x-ethos-signature': genericSignature(SECRET, rawBody, timestamp) },
        now,
      }),
    ).toEqual({ ok: false, reason: 'missing_timestamp_header' });
  });

  it('refuses a non-numeric timestamp', () => {
    expect(
      verifySipWebhook({
        provider: 'generic',
        secret: SECRET,
        rawBody,
        headers: {
          'x-ethos-signature': `t=yesterday,v1=${genericSignature(SECRET, rawBody, timestamp)}`,
        },
        now,
      }),
    ).toEqual({ ok: false, reason: 'malformed_timestamp' });
  });

  it('reads headers case-insensitively and unwraps array header values', () => {
    expect(
      verifySipWebhook({
        provider: 'generic',
        secret: SECRET,
        rawBody,
        headers: {
          'X-Ethos-Signature': [genericSignature(SECRET, rawBody, timestamp)],
          'X-Ethos-Timestamp': timestamp,
        },
        now,
      }),
    ).toEqual({ ok: true });
  });
});

describe('verifySipWebhook — refusal hygiene', () => {
  it('refuses an unknown provider', () => {
    expect(
      verifySipWebhook({
        provider: 'sms' as SipWebhookProvider,
        secret: SECRET,
        rawBody: '{}',
        headers: {},
        now,
      }),
    ).toEqual({ ok: false, reason: 'unknown_provider' });
  });

  it('never puts the secret or the received signature in a reason', () => {
    const badSignature = 'deadbeef'.repeat(8);
    const results: VerifyWebhookResult[] = [
      verifySipWebhook({
        provider: 'generic',
        secret: SECRET,
        rawBody: '{}',
        headers: { 'x-ethos-signature': badSignature, 'x-ethos-timestamp': String(NOW_SECONDS) },
        now,
      }),
      verifySipWebhook({
        provider: 'twilio',
        secret: SECRET,
        rawBody: '',
        url: 'https://hooks.example.com/voice',
        headers: { 'x-twilio-signature': badSignature },
        now,
      }),
      verifySipWebhook({
        provider: 'telnyx',
        secret: TELNYX_PUBLIC_KEY,
        rawBody: '{}',
        headers: {
          'telnyx-signature-ed25519': badSignature,
          'telnyx-timestamp': String(NOW_SECONDS),
        },
        now,
      }),
      verifySipWebhook({
        provider: 'livekit',
        secret: SECRET,
        rawBody: '{}',
        headers: { authorization: `Bearer a.b.${badSignature}` },
        now,
      }),
    ];

    for (const result of results) {
      expect(result.ok).toBe(false);
      const reason = result.ok ? '' : result.reason;
      expect(reason).not.toContain(SECRET);
      expect(reason).not.toContain(TELNYX_PUBLIC_KEY);
      expect(reason).not.toContain(badSignature);
    }
  });
});

// --- parseInboundSipCall ---------------------------------------------------

describe('parseInboundSipCall', () => {
  it('maps a Twilio voice webhook', () => {
    expect(
      parseInboundSipCall('twilio', {
        CallSid: 'CA123',
        From: '+15551234567',
        To: '+15550000001',
        CallStatus: 'ringing',
        Direction: 'inbound',
      }),
    ).toEqual({
      fromNumber: '+15551234567',
      toNumber: '+15550000001',
      roomName: 'call-15550000001-15551234567',
    });
  });

  it('maps a Telnyx call event', () => {
    expect(
      parseInboundSipCall('telnyx', {
        data: {
          event_type: 'call.initiated',
          payload: {
            call_control_id: 'v3:abc',
            from: '+15551234567',
            to: '+15550000001',
          },
        },
      }),
    ).toEqual({
      fromNumber: '+15551234567',
      toNumber: '+15550000001',
      roomName: 'call-15550000001-15551234567',
    });
  });

  it('maps a LiveKit participant_joined webhook with its room name', () => {
    expect(
      parseInboundSipCall('livekit', {
        event: 'participant_joined',
        room: { name: 'sip-room-42' },
        participant: {
          identity: 'sip_+15551234567',
          attributes: {
            'sip.phoneNumber': '+15551234567',
            'sip.trunkPhoneNumber': '+15550000001',
          },
        },
      }),
    ).toEqual({
      fromNumber: '+15551234567',
      toNumber: '+15550000001',
      roomName: 'sip-room-42',
    });
  });

  it('maps the generic shape', () => {
    expect(parseInboundSipCall('generic', { from: '+1555', to: '+1666', room: 'r1' })).toEqual({
      fromNumber: '+1555',
      toNumber: '+1666',
      roomName: 'r1',
    });
  });

  it('returns null for a payload that is not a call event', () => {
    // Twilio SMS carries From/To too — CallSid is what makes it a call.
    expect(parseInboundSipCall('twilio', { MessageSid: 'SM1', From: '+1', To: '+2' })).toBeNull();
    expect(
      parseInboundSipCall('telnyx', { data: { event_type: 'message.received', payload: {} } }),
    ).toBeNull();
    expect(
      parseInboundSipCall('livekit', { event: 'participant_joined', participant: {} }),
    ).toBeNull();
  });

  it('returns null when from/to are missing, and never throws on junk', () => {
    expect(parseInboundSipCall('generic', { from: '+1' })).toBeNull();
    expect(parseInboundSipCall('generic', null)).toBeNull();
    expect(parseInboundSipCall('generic', 'not-an-object')).toBeNull();
    expect(parseInboundSipCall('twilio', [])).toBeNull();
  });

  it('derives a stable fallback room name for the same call', () => {
    const payload = { CallSid: 'CA1', From: '+1 (555) 123-4567', To: '+1-555-000-0001' };
    const first = parseInboundSipCall('twilio', payload);
    const second = parseInboundSipCall('twilio', payload);
    expect(first?.roomName).toBe('call-15550000001-15551234567');
    expect(second?.roomName).toBe(first?.roomName);
  });
});
