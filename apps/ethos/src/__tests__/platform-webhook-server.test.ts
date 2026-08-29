import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPlatformWebhookServer,
  type PlatformWebhookHandler,
  type PlatformWebhookServerOptions,
} from '../platform-webhook-server';

// Real server on port 0, real `fetch`. Not synthesized req/res objects: both
// platform handlers read the request STREAM themselves, so a faked pair would
// bypass the exact code path this file exists to protect (the body must arrive
// unconsumed and unparsed).

let server: Server | undefined;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  server?.close();
  server = undefined;
  warn.mockRestore();
  error.mockRestore();
});

function start(opts: Omit<PlatformWebhookServerOptions, 'port' | 'host'>): Promise<number> {
  return new Promise((resolve) => {
    const s = createPlatformWebhookServer({ port: 0, host: '127.0.0.1', ...opts });
    server = s;
    s.once('listening', () => resolve((s.address() as AddressInfo).port));
  });
}

/** A stand-in adapter handler: answers 200 with its own name. */
function okHandler(name: string) {
  return vi.fn((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(name);
  });
}

function request(
  port: number,
  path: string,
  init: { method?: string; body?: string } = {},
): Promise<{ status: number; body: string }> {
  const method = init.method ?? 'POST';
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : (init.body ?? '{}'),
  }).then(async (res) => ({ status: res.status, body: await res.text() }));
}

describe('createPlatformWebhookServer', () => {
  describe('Telegram dispatch (§9 multi-bot dispatch test)', () => {
    it('routes /telegram/webhook/<botKey> to only that bot’s handler', async () => {
      const a = okHandler('bot-a');
      const b = okHandler('bot-b');
      const port = await start({
        telegram: new Map([
          ['alpha', a],
          ['beta', b],
        ]),
      });

      const first = await request(port, '/telegram/webhook/alpha');
      expect(first.status).toBe(200);
      expect(first.body).toBe('bot-a');
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).not.toHaveBeenCalled();

      const second = await request(port, '/telegram/webhook/beta');
      expect(second.status).toBe(200);
      expect(second.body).toBe('bot-b');
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it('404s an unknown botKey segment without invoking any handler', async () => {
      const a = okHandler('bot-a');
      const port = await start({ telegram: new Map([['alpha', a]]) });

      const res = await request(port, '/telegram/webhook/nope');
      expect(res.status).toBe(404);
      expect(a).not.toHaveBeenCalled();
    });
  });

  describe('Slack dispatch (§9 botKey dispatch test)', () => {
    it('routes /slack/events/<botKey> to only that app’s handler', async () => {
      const a = okHandler('app-a');
      const b = okHandler('app-b');
      const port = await start({
        slack: new Map([
          ['/slack/events/alpha', a],
          ['/slack/events/beta', b],
        ]),
      });

      const first = await request(port, '/slack/events/alpha');
      expect(first.status).toBe(200);
      expect(first.body).toBe('app-a');
      expect(b).not.toHaveBeenCalled();

      const second = await request(port, '/slack/events/beta');
      expect(second.body).toBe('app-b');
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it('honours a webhookPath override as the mount path', async () => {
      const overridden = okHandler('custom');
      const conventional = okHandler('conventional');
      const port = await start({
        slack: new Map([
          ['/slack/events/custom-hook', overridden],
          ['/slack/events/beta', conventional],
        ]),
      });

      const res = await request(port, '/slack/events/custom-hook');
      expect(res.status).toBe(200);
      expect(res.body).toBe('custom');
      expect(conventional).not.toHaveBeenCalled();
    });

    it('404s an unknown Slack route', async () => {
      const a = okHandler('app-a');
      const port = await start({ slack: new Map([['/slack/events/alpha', a]]) });

      const res = await request(port, '/slack/events/unknown');
      expect(res.status).toBe(404);
      expect(a).not.toHaveBeenCalled();
    });
  });

  it('404s a non-POST request', async () => {
    const a = okHandler('bot-a');
    const port = await start({ telegram: new Map([['alpha', a]]) });

    const res = await request(port, '/telegram/webhook/alpha', { method: 'GET' });
    expect(res.status).toBe(404);
    expect(a).not.toHaveBeenCalled();
  });

  it('hands the request over with the body unread and unparsed', async () => {
    // Slack's HMAC covers these exact bytes, so the handler — not the server —
    // must be the first thing to touch the stream.
    const raw = '{"event":{"text":"hello"},"spacing":  "preserved"}';
    let seen: string | undefined;
    let readableAtEntry: boolean | undefined;

    const handler: PlatformWebhookHandler = async (req, res) => {
      readableAtEntry = req.readable;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      seen = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200);
      res.end('read');
    };

    const port = await start({ telegram: new Map([['alpha', handler]]) });
    const res = await request(port, '/telegram/webhook/alpha', { body: raw });

    expect(res.status).toBe(200);
    expect(readableAtEntry).toBe(true);
    expect(seen).toBe(raw);
  });

  it('turns a synchronous handler throw into a 500 and keeps serving', async () => {
    // Bolt's HTTPReceiver throws synchronously on an endpoint miss.
    const boom: PlatformWebhookHandler = () => {
      throw new Error('endpoint miss');
    };
    const healthy = okHandler('bot-b');
    const port = await start({
      slack: new Map<string, PlatformWebhookHandler>([
        ['/slack/events/alpha', boom],
        ['/slack/events/beta', healthy],
      ]),
    });

    const failed = await request(port, '/slack/events/alpha');
    expect(failed.status).toBe(500);

    const after = await request(port, '/slack/events/beta');
    expect(after.status).toBe(200);
    expect(after.body).toBe('bot-b');
  });

  it('turns an asynchronous handler rejection into a 500', async () => {
    const boom: PlatformWebhookHandler = async () => {
      await Promise.resolve();
      throw new Error('async failure');
    };
    const port = await start({ telegram: new Map([['alpha', boom]]) });

    const res = await request(port, '/telegram/webhook/alpha');
    expect(res.status).toBe(500);
  });

  it('starts and 404s everything when no handlers are registered', async () => {
    // The "only start when at least one bot needs it" gating lives in the
    // gateway wiring, not here — constructing an empty server must not throw.
    const port = await start({});

    expect((await request(port, '/telegram/webhook/alpha')).status).toBe(404);
    expect((await request(port, '/slack/events/alpha')).status).toBe(404);
    expect((await request(port, '/anything-else')).status).toBe(404);
  });

  it('serves Telegram and Slack routes side by side without interference', async () => {
    const telegram = okHandler('telegram');
    const slack = okHandler('slack');
    const port = await start({
      telegram: new Map([['alpha', telegram]]),
      slack: new Map([['/slack/events/alpha', slack]]),
    });

    expect((await request(port, '/telegram/webhook/alpha')).body).toBe('telegram');
    expect((await request(port, '/slack/events/alpha')).body).toBe('slack');
    expect(telegram).toHaveBeenCalledTimes(1);
    expect(slack).toHaveBeenCalledTimes(1);
  });
});
