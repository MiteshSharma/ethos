import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { InboundSipCall } from '@ethosagent/platform-voice';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSipWebhookServer } from '../sip-webhook-server';

// Every raw body the verifier was actually handed. The signature has to cover
// the bytes that arrived on the socket, and the only way to PROVE that (rather
// than infer it from a passing HMAC) is to look at the string the verifier saw.
const verifiedBodies: string[] = [];

vi.mock('@ethosagent/platform-voice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ethosagent/platform-voice')>();
  return {
    ...actual,
    verifySipWebhook: (input: Parameters<typeof actual.verifySipWebhook>[0]) => {
      verifiedBodies.push(input.rawBody);
      return actual.verifySipWebhook(input);
    },
  };
});

const SECRET = 'trunk-shared-secret';
const CALL_BODY = JSON.stringify({ from: '+15550001111', to: '+15557654321' });

let server: Server | undefined;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  verifiedBodies.length = 0;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  server?.close();
  server = undefined;
  warn.mockRestore();
  error.mockRestore();
});

function start(
  onCall: (call: InboundSipCall, raw: unknown) => Promise<void>,
  path = '/sip/inbound',
): Promise<number> {
  return new Promise((resolve) => {
    const s = createSipWebhookServer({
      port: 0,
      host: '127.0.0.1',
      path,
      provider: 'generic',
      secret: SECRET,
      onCall,
    });
    server = s;
    s.once('listening', () => resolve((s.address() as AddressInfo).port));
  });
}

/** The `generic` scheme: HMAC-SHA256 over `<timestamp>.<rawBody>`, hex. */
function sign(rawBody: string, secret = SECRET): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    'x-ethos-timestamp': timestamp,
    'x-ethos-signature': createHmac('sha256', secret)
      .update(`${timestamp}.${rawBody}`, 'utf8')
      .digest('hex'),
  };
}

function post(
  port: number,
  path: string,
  body: string,
  headers: Record<string, string> = {},
  method = 'POST',
): Promise<{ status: number; body: string }> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: method === 'GET' ? undefined : body,
  }).then(async (res) => ({ status: res.status, body: await res.text() }));
}

/** Resolves once the detached `onCall` dispatch has had a turn to run. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('createSipWebhookServer', () => {
  it('202s a verified call and fires onCall exactly once', async () => {
    const calls: InboundSipCall[] = [];
    const port = await start(async (call) => {
      calls.push(call);
    });

    const res = await post(port, '/sip/inbound', CALL_BODY, sign(CALL_BODY));
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ accepted: true });

    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ fromNumber: '+15550001111', toNumber: '+15557654321' });
  });

  it('verifies the exact bytes that were POSTed, not a re-serialization', async () => {
    // Deliberately NOT what `JSON.stringify(JSON.parse(body))` produces: spaces
    // inside the object, and `to` before `from`. A server that verified a
    // round-tripped body would compute a different HMAC and 401 here.
    const raw = '{ "to" : "+15557654321",\n  "from": "+15550001111" }';
    const port = await start(async () => {});

    const res = await post(port, '/sip/inbound', raw, sign(raw));
    expect(res.status).toBe(202);
    expect(verifiedBodies).toEqual([raw]);
  });

  it('401s a bad signature without firing onCall or leaking why', async () => {
    let fired = false;
    const port = await start(async () => {
      fired = true;
    });

    const res = await post(port, '/sip/inbound', CALL_BODY, sign(CALL_BODY, 'wrong-secret'));
    expect(res.status).toBe(401);
    await settle();
    expect(fired).toBe(false);

    // The refusal reason and the secret are operator-console material. A 401
    // that names which of four checks failed is a probe oracle.
    expect(res.body).not.toContain('invalid_signature');
    expect(res.body).not.toContain('signature');
    expect(res.body).not.toContain(SECRET);
    expect(JSON.parse(res.body)).toEqual({ error: 'unauthorized' });
    // …and it IS reported to the operator.
    expect(warn.mock.calls.flat().join(' ')).toContain('invalid_signature');
  });

  it('401s an unsigned request', async () => {
    let fired = false;
    const port = await start(async () => {
      fired = true;
    });
    const res = await post(port, '/sip/inbound', CALL_BODY);
    expect(res.status).toBe(401);
    await settle();
    expect(fired).toBe(false);
  });

  it('200 { ignored: true } for a verified non-call payload', async () => {
    // Providers retry non-2xx. Retrying a status callback forever is worse than
    // acknowledging it once.
    const body = JSON.stringify({ event: 'trunk.heartbeat' });
    let fired = false;
    const port = await start(async () => {
      fired = true;
    });

    const res = await post(port, '/sip/inbound', body, sign(body));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ignored: true });
    await settle();
    expect(fired).toBe(false);
  });

  it('200 { ignored: true } for a verified body that is not JSON at all', async () => {
    const body = 'not json';
    const port = await start(async () => {});
    const res = await post(port, '/sip/inbound', body, sign(body));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ignored: true });
  });

  it('404s the wrong path and the wrong method', async () => {
    const port = await start(async () => {});
    expect((await post(port, '/nope', CALL_BODY, sign(CALL_BODY))).status).toBe(404);
    expect((await post(port, '/sip/inbound', '', {}, 'GET')).status).toBe(404);
  });

  it('honours a custom mount path', async () => {
    const port = await start(async () => {}, '/voice/inbound');
    expect((await post(port, '/sip/inbound', CALL_BODY, sign(CALL_BODY))).status).toBe(404);
    expect((await post(port, '/voice/inbound', CALL_BODY, sign(CALL_BODY))).status).toBe(202);
  });

  it('ignores a query string when matching the mount path', async () => {
    const port = await start(async () => {});
    expect((await post(port, '/sip/inbound?x=1', CALL_BODY, sign(CALL_BODY))).status).toBe(202);
  });

  it('still 202s when onCall rejects, and does not crash the process', async () => {
    // A ringing phone will not wait for a provider socket to open, so the
    // response is already sent by the time the handler runs — its failure has
    // nowhere to propagate except the log.
    const port = await start(async () => {
      throw new Error('adapter construction exploded');
    });
    const res = await post(port, '/sip/inbound', CALL_BODY, sign(CALL_BODY));
    expect(res.status).toBe(202);
    await settle();
    expect(error.mock.calls.flat().join(' ')).toContain('dispatch failed');
  });

  it('still 202s when onCall throws synchronously', async () => {
    const port = await start((() => {
      throw new Error('sync boom');
    }) as (call: InboundSipCall, raw: unknown) => Promise<void>);
    const res = await post(port, '/sip/inbound', CALL_BODY, sign(CALL_BODY));
    expect(res.status).toBe(202);
    await settle();
    expect(error.mock.calls.flat().join(' ')).toContain('dispatch failed');
  });

  it('answers before the dispatch finishes', async () => {
    // The 202 must not wait on `onCall`; a trunk that times out re-rings.
    let release: () => void = () => {};
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const port = await start(() => blocked);
    const res = await post(port, '/sip/inbound', CALL_BODY, sign(CALL_BODY));
    expect(res.status).toBe(202);
    release();
  });

  it('parses a form-encoded body (Twilio posts x-www-form-urlencoded)', async () => {
    // Not a cosmetic detail: parsing the form shape as JSON makes every Twilio
    // call look like a non-call event, i.e. the phone quietly never answers.
    const body = new URLSearchParams({ from: '+15550001111', to: '+15557654321' }).toString();
    const calls: InboundSipCall[] = [];
    const port = await start(async (call) => {
      calls.push(call);
    });
    const res = await post(port, '/sip/inbound', body, {
      ...sign(body),
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(res.status).toBe(202);
    await settle();
    expect(calls[0]).toMatchObject({ fromNumber: '+15550001111' });
  });

  it('warns rather than throws when the port is already taken', async () => {
    const first = await start(async () => {});
    const second = createSipWebhookServer({
      port: first,
      host: '127.0.0.1',
      path: '/sip/inbound',
      provider: 'generic',
      secret: SECRET,
      onCall: async () => {},
    });
    await new Promise((r) => setTimeout(r, 50));
    second.close();
    expect(warn.mock.calls.flat().join(' ')).toContain('in use');
  });
});
