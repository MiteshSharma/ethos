import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryAttachmentCache } from '@ethosagent/storage-fs';
import type { InboundMessage } from '@ethosagent/types';
import type { PollingOptions, Transformer } from 'grammy';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Real grammy, stubbed network.
//
// Unlike the sibling test files (which replace `Bot` with a hand-rolled
// `MockBot`), these cases need grammy's REAL `webhookCallback` — the whole
// point is to prove the `'http'` framework adapter verifies the secret token
// and dispatches an update over a plain `node:http` request. Asserting that
// against our own mock would only prove the mock works.
//
// So we subclass the real `Bot` and cut the wire at the only two places it
// touches the network: an API transformer (every `bot.api.*` call, including
// the `getMe` that `bot.init()` performs) and the long-polling `start()`.
// ---------------------------------------------------------------------------

const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: 'Bot',
  username: 'testbot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

const apiCalls: { method: string; payload: Record<string, unknown> }[] = [];
const startCalls: (PollingOptions | undefined)[] = [];
const stopCalls: number[] = [];

vi.mock('grammy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('grammy')>();
  class TestBot extends actual.Bot {
    constructor(token: string) {
      super(token);
      const stub = ((_prev: unknown, method: string, payload: Record<string, unknown>) => {
        apiCalls.push({ method, payload });
        return Promise.resolve({
          ok: true,
          result: method === 'getMe' ? BOT_INFO : true,
        });
      }) as unknown as Transformer;
      this.api.config.use(stub);
    }
    override start(options?: PollingOptions): Promise<void> {
      startCalls.push(options);
      return Promise.resolve();
    }
    override stop(): Promise<void> {
      stopCalls.push(1);
      return Promise.resolve();
    }
  }
  return { ...actual, Bot: TestBot };
});

import { Bot, webhookCallback } from 'grammy';
import { TelegramAdapter, type TelegramAdapterConfig } from '../index';

const SECRET = 'super-secret-token';
const SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';

let cache: InMemoryAttachmentCache;

beforeEach(() => {
  apiCalls.length = 0;
  startCalls.length = 0;
  stopCalls.length = 0;
  cache = new InMemoryAttachmentCache();
});

function mk(overrides: Partial<TelegramAdapterConfig> = {}): TelegramAdapter {
  return new TelegramAdapter({
    token: '1:fake-token',
    cache,
    botKey: 'bot-a',
    ...overrides,
  });
}

function webhookConfig(overrides: Partial<TelegramAdapterConfig> = {}): TelegramAdapter {
  return mk({
    useWebhook: true,
    webhookUrl: 'https://example.test/telegram/webhook/bot-a',
    webhookSecretToken: SECRET,
    ...overrides,
  });
}

/** A minimal, well-formed Telegram Update carrying a DM text message. */
function update(text = 'hello from webhook') {
  return {
    update_id: 1,
    message: {
      message_id: 100,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 555, type: 'private', first_name: 'Ada' },
      from: { id: 777, is_bot: false, first_name: 'Ada', username: 'ada' },
      text,
    },
  };
}

/**
 * Drive a real `node:http` request through a handler. Deliberately a real
 * server + real `fetch` rather than fake req/res objects: grammy's `'http'`
 * adapter reads the raw body off the request stream itself, so a stubbed
 * object would not exercise the code path this suite exists to verify.
 */
async function post(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.writableEnded) res.writeHead(500).end('handler-threw');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/telegram/webhook/bot-a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('grammy framework adapter selection', () => {
  // Reproduces the gap: the adapter asked grammy for an Express-shaped
  // handler, but nothing in this repo depends on `express` and the host that
  // mounts `adapter.webhook` is a plain `node:http` server. The Express
  // adapter reads `req.body` (never populated) and calls `req.header(...)`
  // (not a method on `IncomingMessage`), so the update never reaches the bot.
  it("'express' cannot serve a plain node:http request", async () => {
    const bot = new Bot('1:fake-token');
    const seen: unknown[] = [];
    bot.on('message', (ctx) => {
      seen.push(ctx.message.text);
    });
    const cb = webhookCallback(bot, 'express', { secretToken: SECRET }) as unknown as (
      req: IncomingMessage,
      res: ServerResponse,
    ) => Promise<void>;

    const res = await post(cb, update(), { [SECRET_HEADER]: SECRET });

    expect(res.status).not.toBe(200);
    expect(seen).toEqual([]);
  });

  it("'http' serves a plain node:http request", async () => {
    const bot = new Bot('1:fake-token');
    const seen: unknown[] = [];
    bot.on('message', (ctx) => {
      seen.push(ctx.message.text);
    });
    const cb = webhookCallback(bot, 'http', { secretToken: SECRET });

    const res = await post(cb, update(), { [SECRET_HEADER]: SECRET });

    expect(res.status).toBe(200);
    expect(seen).toEqual(['hello from webhook']);
  });
});

describe('TelegramAdapter webhook handler', () => {
  it('delivers an update to the same onMessage pipeline long-poll uses', async () => {
    const adapter = webhookConfig();
    const received: InboundMessage[] = [];
    adapter.onMessage((m) => received.push(m));
    await adapter.start();

    const handler = adapter.webhook;
    expect(handler).toBeDefined();
    if (!handler) return;

    const res = await post(handler, update(), { [SECRET_HEADER]: SECRET });

    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].platform).toBe('telegram');
    expect(received[0].botKey).toBe('bot-a');
    expect(received[0].chatId).toBe('555');
    expect(received[0].text).toBe('hello from webhook');
    expect(received[0].isDm).toBe(true);
  });

  it('stamps the configured botKey, not a derived one', async () => {
    const adapter = webhookConfig({ botKey: 'second-bot' });
    const received: InboundMessage[] = [];
    adapter.onMessage((m) => received.push(m));
    await adapter.start();

    const handler = adapter.webhook;
    if (!handler) throw new Error('webhook handler missing');
    await post(handler, update(), { [SECRET_HEADER]: SECRET });

    expect(received.map((m) => m.botKey)).toEqual(['second-bot']);
  });

  it('rejects a wrong secret token with 401 and never dispatches', async () => {
    const adapter = webhookConfig();
    const received: InboundMessage[] = [];
    adapter.onMessage((m) => received.push(m));
    await adapter.start();

    const handler = adapter.webhook;
    if (!handler) throw new Error('webhook handler missing');
    const res = await post(handler, update(), { [SECRET_HEADER]: 'wrong-token' });

    expect(res.status).toBe(401);
    expect(received).toEqual([]);
  });

  it('rejects a missing secret-token header with 401 and never dispatches', async () => {
    const adapter = webhookConfig();
    const received: InboundMessage[] = [];
    adapter.onMessage((m) => received.push(m));
    await adapter.start();

    const handler = adapter.webhook;
    if (!handler) throw new Error('webhook handler missing');
    const res = await post(handler, update());

    expect(res.status).toBe(401);
    expect(received).toEqual([]);
  });
});

describe('TelegramAdapter webhook lifecycle', () => {
  it('start() registers the webhook and does not start long polling', async () => {
    const adapter = webhookConfig();
    await adapter.start();

    const setWebhook = apiCalls.filter((c) => c.method === 'setWebhook');
    expect(setWebhook).toHaveLength(1);
    expect(setWebhook[0].payload).toMatchObject({
      url: 'https://example.test/telegram/webhook/bot-a',
      secret_token: SECRET,
    });
    expect(startCalls).toEqual([]);
  });

  it('stop() deletes the webhook and does not stop the poller', async () => {
    const adapter = webhookConfig();
    await adapter.start();
    await adapter.stop();

    expect(apiCalls.filter((c) => c.method === 'deleteWebhook')).toHaveLength(1);
    expect(stopCalls).toEqual([]);
  });

  it('long-poll mode neither registers nor deletes a webhook', async () => {
    const adapter = mk();
    await adapter.start();
    await adapter.stop();

    expect(apiCalls.filter((c) => c.method === 'setWebhook')).toEqual([]);
    expect(apiCalls.filter((c) => c.method === 'deleteWebhook')).toEqual([]);
    expect(startCalls).toHaveLength(1);
    expect(stopCalls).toHaveLength(1);
  });

  it('useWebhook without webhookUrl throws', async () => {
    const adapter = mk({ useWebhook: true, webhookSecretToken: SECRET });
    await expect(adapter.start()).rejects.toThrow(/webhookUrl/);
  });

  it('useWebhook without webhookSecretToken throws', async () => {
    const adapter = mk({ useWebhook: true, webhookUrl: 'https://example.test/hook' });
    await expect(adapter.start()).rejects.toThrow(/webhookSecretToken/);
  });
});

describe('TelegramAdapter dropPendingUpdates', () => {
  it('defaults to true on the long-poll branch', async () => {
    await mk().start();
    expect(startCalls).toEqual([{ drop_pending_updates: true }]);
  });

  it('threads an explicit false through to bot.start()', async () => {
    await mk({ dropPendingUpdates: false }).start();
    expect(startCalls).toEqual([{ drop_pending_updates: false }]);
  });

  it('is irrelevant in webhook mode — bot.start() is never called', async () => {
    await webhookConfig({ dropPendingUpdates: false }).start();
    expect(startCalls).toEqual([]);
  });
});

describe('TelegramAdapter webhook capabilities', () => {
  it('reports webhookMode from useWebhook', () => {
    expect(webhookConfig().capabilities.webhookMode).toBe(true);
    expect(mk().capabilities.webhookMode).toBe(false);
  });

  it('exposes no handler before start() or in long-poll mode', async () => {
    const adapter = webhookConfig();
    expect(adapter.webhook).toBeUndefined();
    await adapter.start();
    expect(adapter.webhook).toBeDefined();

    const polling = mk();
    await polling.start();
    expect(polling.webhook).toBeUndefined();
  });
});
