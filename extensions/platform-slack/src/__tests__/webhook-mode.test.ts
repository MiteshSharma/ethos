// Slack HTTP Events mode (`mode.http`) — receiver construction, transport
// exclusivity, and the wiring that carries a real inbound HTTP request into
// Bolt's `HTTPReceiver`.
//
// These tests deliberately use the REAL `@slack/bolt` rather than a module
// mock: signature verification and the `url_verification` challenge are
// Bolt's own behaviour, and the thing under test is whether our wiring
// reaches it. Constructing a Bolt `App` is network-free in both modes (the
// receivers connect only on `start()`), so no mock is needed.

import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import boltPkg from '@slack/bolt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlackAdapter, type SlackAdapterConfig } from '../adapter';

const { App, HTTPReceiver, SocketModeReceiver } = boltPkg;

const SIGNING_SECRET = 'test-signing-secret';

// Bolt's `App` constructor eagerly fires `auth.test` on the bot token to
// resolve the bot's own identity, and authorizes every inbound event against
// that same result. Neither is what these tests are about, and both would
// otherwise be real network calls to slack.com. Stub the WebClient's single
// dispatch method on its prototype, before any adapter is constructed —
// `bindApiCall` resolves `apiCall` through the prototype chain when the
// client is built, so a prototype-level stub is captured by every later
// client. The prototype is reached through a throwaway `App` built with an
// explicit `authorize` (and no token), which is the one construction shape
// that does NOT fire the eager call.
const probeApp = new App({
  receiver: new HTTPReceiver({ signingSecret: SIGNING_SECRET }),
  authorize: async () => ({ botToken: 'xoxb-fake', botUserId: 'UBOT', botId: 'BBOT' }),
});
const webClientProto = Object.getPrototypeOf(probeApp.client) as {
  apiCall: (...args: unknown[]) => Promise<unknown>;
};
vi.spyOn(webClientProto, 'apiCall').mockResolvedValue({
  ok: true,
  user_id: 'UBOT',
  bot_id: 'BBOT',
});

function makeConfig(over: Partial<SlackAdapterConfig> = {}): SlackAdapterConfig {
  return {
    botToken: 'xoxb-fake',
    appToken: 'xapp-fake',
    signingSecret: SIGNING_SECRET,
    botKey: 'bot-1',
    ...over,
  };
}

/** Reach the Bolt `App` the adapter built. The receiver it was given is
 *  observable nowhere else without starting a live transport — the same
 *  private-field seam `slack.test.ts` uses for `webUiBaseUrl`. */
function boltAppOf(adapter: SlackAdapter): { receiver: unknown; socketMode?: boolean } {
  return (adapter as unknown as { app: { receiver: unknown; socketMode?: boolean } }).app;
}

// ---------------------------------------------------------------------------
// Receiver construction
// ---------------------------------------------------------------------------

describe('SlackAdapter — receiver construction', () => {
  it('mode.http builds an App backed by an HTTPReceiver, with no socketMode', () => {
    const adapter = new SlackAdapter(makeConfig({ mode: { http: true, socket: false } }));
    const app = boltAppOf(adapter);
    expect(app.receiver).toBeInstanceOf(HTTPReceiver);
    expect(app.socketMode).not.toBe(true);
  });

  it('mode.socket builds today’s Socket Mode App unchanged', () => {
    const adapter = new SlackAdapter(makeConfig({ mode: { socket: true } }));
    const app = boltAppOf(adapter);
    expect(app.receiver).toBeInstanceOf(SocketModeReceiver);
    expect(app.socketMode).toBe(true);
  });

  // Regression guard (§9 "Default-preserving test"): a config with no `mode`
  // key at all must behave byte-for-byte as it does today. This is what makes
  // HTTP mode additive rather than a silent behaviour change.
  it('no mode key at all defaults to Socket Mode, exactly as today', () => {
    const adapter = new SlackAdapter(makeConfig());
    const app = boltAppOf(adapter);
    expect(app.receiver).toBeInstanceOf(SocketModeReceiver);
    expect(app.socketMode).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe('SlackAdapter — transport config validation', () => {
  it('throws when socket and http are both enabled', () => {
    expect(() => new SlackAdapter(makeConfig({ mode: { socket: true, http: true } }))).toThrow(
      /mutually exclusive/i,
    );
  });

  it('throws when socket mode is selected without an appToken', () => {
    expect(() => new SlackAdapter(makeConfig({ appToken: undefined }))).toThrow(/appToken/);
  });

  it('throws when http mode is selected without a signingSecret', () => {
    expect(
      () =>
        new SlackAdapter(
          makeConfig({ signingSecret: undefined, mode: { socket: false, http: true } }),
        ),
    ).toThrow(/signingSecret/);
  });

  it('http mode needs no appToken', () => {
    expect(
      () =>
        new SlackAdapter(makeConfig({ appToken: undefined, mode: { socket: false, http: true } })),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Surfaced handles
// ---------------------------------------------------------------------------

describe('SlackAdapter — HTTP mode handles', () => {
  it('reports webhookMode in capabilities only in http mode', () => {
    const http = new SlackAdapter(makeConfig({ mode: { socket: false, http: true } }));
    const socket = new SlackAdapter(makeConfig());
    expect(http.capabilities.webhookMode).toBe(true);
    expect(socket.capabilities.webhookMode).toBe(false);
  });

  it('exposes no requestListener in socket mode', () => {
    const adapter = new SlackAdapter(makeConfig());
    expect(adapter.requestListener).toBeUndefined();
    expect(adapter.webhookRoute).toBeUndefined();
  });

  it('exposes a requestListener and route in http mode, defaulting the route to botKey', () => {
    const adapter = new SlackAdapter(
      makeConfig({ botKey: 'coder-app', mode: { socket: false, http: true } }),
    );
    expect(typeof adapter.requestListener).toBe('function');
    expect(adapter.webhookRoute).toBe('/slack/events/coder-app');
  });

  it('webhookPath config overrides the route segment', () => {
    const adapter = new SlackAdapter(
      makeConfig({
        botKey: 'coder-app',
        webhookPath: 'custom',
        mode: { socket: false, http: true },
      }),
    );
    expect(adapter.webhookRoute).toBe('/slack/events/custom');
  });
});

// ---------------------------------------------------------------------------
// Real HTTP requests through the mounted listener
// ---------------------------------------------------------------------------

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
});

/**
 * Mount the adapter's listener on a real ephemeral-port server, the way
 * `platform-webhook-server.ts` will. The try/catch mirrors what that server
 * must do: Bolt's `requestListener` throws synchronously on a path outside
 * its endpoint list.
 */
async function mount(adapter: SlackAdapter): Promise<string> {
  const listener = adapter.requestListener;
  if (!listener) throw new Error('adapter exposes no requestListener');
  const server = createServer((req, res) => {
    try {
      listener(req, res);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** Slack's `v0:{timestamp}:{rawBody}` HMAC-SHA256 request signature. */
function sign(timestampSec: number, rawBody: string, secret = SIGNING_SECRET): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestampSec}:${rawBody}`).digest('hex')}`;
}

interface PostOpts {
  timestampSec?: number;
  signature?: string;
  headers?: Record<string, string>;
}

async function post(
  base: string,
  path: string,
  body: unknown,
  opts: PostOpts = {},
): Promise<Response> {
  const raw = JSON.stringify(body);
  const ts = opts.timestampSec ?? Math.floor(Date.now() / 1000);
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': String(ts),
      'x-slack-signature': opts.signature ?? sign(ts, raw),
      ...opts.headers,
    },
    body: raw,
  });
}

function httpAdapter(over: Partial<SlackAdapterConfig> = {}): SlackAdapter {
  return new SlackAdapter(makeConfig({ mode: { socket: false, http: true }, ...over }));
}

describe('SlackAdapter — url_verification challenge', () => {
  it('echoes the challenge back on the adapter’s route', async () => {
    const adapter = httpAdapter({ botKey: 'chal-bot' });
    const base = await mount(adapter);
    const res = await post(base, '/slack/events/chal-bot', {
      type: 'url_verification',
      token: 'legacy',
      challenge: 'c-abc-123',
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ challenge: 'c-abc-123' });
  });

  it('does not answer on a path this adapter does not own', async () => {
    const adapter = httpAdapter({ botKey: 'chal-bot' });
    const base = await mount(adapter);
    const res = await post(base, '/slack/events/other-bot', {
      type: 'url_verification',
      challenge: 'c-abc-123',
    });
    expect(res.status).toBe(404);
  });
});

describe('SlackAdapter — signature verification', () => {
  const challenge = { type: 'url_verification', challenge: 'ok' };

  it('accepts a correctly signed request', async () => {
    const base = await mount(httpAdapter());
    const res = await post(base, '/slack/events/bot-1', challenge);
    expect(res.status).toBe(200);
  });

  it('rejects a request signed with the wrong secret', async () => {
    const base = await mount(httpAdapter());
    const ts = Math.floor(Date.now() / 1000);
    const res = await post(base, '/slack/events/bot-1', challenge, {
      timestampSec: ts,
      signature: sign(ts, JSON.stringify(challenge), 'not-the-secret'),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a stale timestamp outside Bolt’s freshness window', async () => {
    const base = await mount(httpAdapter());
    // Bolt's window is 5 minutes; 10 minutes ago is unambiguously stale. The
    // signature itself is valid — only the timestamp is old.
    const ts = Math.floor(Date.now() / 1000) - 600;
    const res = await post(base, '/slack/events/bot-1', challenge, { timestampSec: ts });
    expect(res.status).toBe(401);
  });
});

describe('SlackAdapter — Slack retry deliveries', () => {
  it('processes a request carrying X-Slack-Retry-Num exactly once', async () => {
    const adapter = httpAdapter({ botKey: 'retry-bot' });
    const app = (
      adapter as unknown as {
        app: { event: (name: string, handler: () => Promise<void>) => void };
      }
    ).app;

    let handled = 0;
    let resolveHandled: () => void = () => {};
    const seen = new Promise<void>((resolve) => {
      resolveHandled = resolve;
    });
    app.event('app_mention', async () => {
      handled += 1;
      resolveHandled();
    });

    const base = await mount(adapter);
    const res = await post(
      base,
      '/slack/events/retry-bot',
      {
        type: 'event_callback',
        token: 'legacy',
        team_id: 'T1',
        api_app_id: 'A1',
        event_id: 'Ev1',
        event_time: Math.floor(Date.now() / 1000),
        event: {
          type: 'app_mention',
          user: 'U123',
          text: 'hi <@UBOT>',
          channel: 'C1',
          ts: '1700000000.1',
        },
      },
      { headers: { 'x-slack-retry-num': '1', 'x-slack-retry-reason': 'http_timeout' } },
    );

    // Not dropped at the HTTP layer: acked like any other delivery...
    expect(res.status).toBe(200);
    // ...and it reaches a listener, exactly once.
    await seen;
    expect(handled).toBe(1);
  });
});
