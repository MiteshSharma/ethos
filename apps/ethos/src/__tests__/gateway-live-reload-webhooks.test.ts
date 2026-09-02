// plan/phases/gateway-live-reload.md Phase C — webhook route add/remove/change.
//
// Two independent mechanisms, tested independently:
//
//   §0 row 5 — the GENERIC webhook route table. Driven against a REAL
//   `createWebhookServer` over REAL HTTP, because the claim being tested is
//   "the running listener serves a route added after it bound", and a stub
//   cannot fail that claim.
//
//   §0 row 6 — the NATIVE Telegram/Slack mount, whose whole content is an
//   ORDER: start() then mount, per adapter. The ordering assertion below is
//   written so an inverted implementation fails it — see the control case.
//
// `commands/boot.ts` is not runtime-importable from vitest (it reaches
// `commands/serve.ts` → `@ethosagent/acp-server`, an app with no alias), which
// is why the sequenced logic lives in `config-reload.ts` and is executed for
// real here, exactly as Phase A did it.

import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type EthosConfig, ethosDir, loadConfigStrict } from '@ethosagent/config';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPlatformWebhookMounts, type PlatformWebhookMounts } from '../commands/gateway';
import {
  platformWebhookKeysFor,
  sliceConfigForBot,
  sliceConfigForWebhook,
  startAndMountPlatformWebhook,
  unmountPlatformWebhook,
} from '../config-reload';
import { createWebhookServer, type WebhookConfig } from '../webhook-server';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

const BASE = ['provider: anthropic', 'model: claude-a', 'apiKey: sk-x', 'personality: researcher'];

async function load(lines: string[]): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), `${lines.join('\n')}\n`);
  const loaded = await loadConfigStrict(storage);
  if (!loaded) throw new Error('loadConfigStrict returned null');
  return loaded.config;
}

/** The minimum a `PlatformAdapter` needs to be one. */
function stubAdapter(id: string, over: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    id,
    displayName: id,
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: async () => {},
    stop: async () => {},
    send: async () => ({ ok: true }),
    onMessage: (_h: (m: InboundMessage) => void) => {},
    health: async () => ({ ok: true }),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// §0 row 5 — the generic webhook route table is live
// ---------------------------------------------------------------------------

describe('generic webhook routes, live', () => {
  const servers: Array<{ close(): void }> = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  it('serves a route added after the listener bound, and stops serving a removed one', async () => {
    // THE LIVE TABLE. `boot.ts` holds exactly this object and mutates it in
    // place; the server resolves `webhooks[hookId]` per request, so no rebind
    // is involved in either direction.
    const live: Record<string, WebhookConfig> = {};

    const server = createWebhookServer(
      0,
      '127.0.0.1',
      {
        handleMessage: async (msg, adapter) => {
          await adapter.send(msg.chatId, { text: `echo:${msg.text}` });
        },
      },
      live,
      () => {
        let reply = '';
        return {
          adapter: stubAdapter('capture', {
            send: async (_chatId, message) => {
              reply = message.text;
              return { ok: true };
            },
          }),
          getReply: () => reply,
        };
      },
    );
    servers.push(server);
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const url = `http://127.0.0.1:${address.port}/webhook/hook1`;
    const post = () =>
      fetch(url, {
        method: 'POST',
        headers: { authorization: 'Bearer s1', 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      });

    // Before the edit: no such route.
    expect((await post()).status).toBe(404);

    // The live edit — the whole of what `addWebhookRouteLive` does to the
    // route table.
    live.hook1 = { personalityId: 'researcher', secret: 's1' };
    const served = await post();
    expect(served.status).toBe(200);
    expect(await served.json()).toEqual({ reply: 'echo:hi' });

    // And a removed route stops being served, same listener.
    delete live.hook1;
    expect((await post()).status).toBe(404);
  });
});

describe('sliceConfigForWebhook', () => {
  it('narrows to exactly the named hook and clears every channel bot', async () => {
    const cfg = await load([
      ...BASE,
      'telegram.bots.0.id: alpha',
      'telegram.bots.0.token: 111:alpha',
      'telegram.bots.0.bind.type: personality',
      'telegram.bots.0.bind.name: researcher',
      'webhooks.hook1.personalityId: researcher',
      'webhooks.hook1.secret: s1',
      'webhooks.hook2.personalityId: coder',
      'webhooks.hook2.secret: s2',
    ]);
    const slice = sliceConfigForWebhook(cfg, 'hook2');
    expect(Object.keys(slice?.webhooks ?? {})).toEqual(['hook2']);
    expect(slice?.webhooks?.hook2?.personalityId).toBe('coder');
    expect(slice?.telegram).toBeUndefined();
    expect(slice?.model).toBe('claude-a');
    expect(sliceConfigForWebhook(cfg, 'ghost')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §0 row 6 — start() strictly before mount, per adapter
// ---------------------------------------------------------------------------

const WEBHOOK_TELEGRAM = [
  'telegram.bots.0.id: alpha',
  'telegram.bots.0.token: 111:alpha',
  'telegram.bots.0.useWebhook: true',
  'telegram.bots.0.webhookUrl: https://example.test/tg',
  'telegram.bots.0.bind.type: personality',
  'telegram.bots.0.bind.name: researcher',
  'channel_filter.telegram.ownerUserId: 42',
];

/**
 * A Telegram-shaped adapter that behaves like the real one: `webhook` is
 * `undefined` until `start()` has resolved. Every read of `webhook` and the
 * completion of `start()` are recorded in `order`.
 */
function webhookAdapter(order: string[]): PlatformAdapter & { readonly webhook?: unknown } {
  let started = false;
  const handler = () => {};
  const adapter = stubAdapter('telegram:alpha', {
    start: async () => {
      // A real `start()` is not synchronous — it registers the webhook with
      // Telegram over the network. The await here is what makes an inverted
      // implementation (mount, then start) actually observe `undefined`.
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('start');
      started = true;
    },
  });
  return Object.defineProperty(adapter, 'webhook', {
    get() {
      order.push('read-webhook');
      return started ? handler : undefined;
    },
    enumerable: true,
  }) as PlatformAdapter & { readonly webhook?: unknown };
}

describe('startAndMountPlatformWebhook — the ordering IS the contract', () => {
  const live = (): PlatformWebhookMounts => ({ telegram: new Map(), slack: new Map() });

  it('starts the adapter strictly before it reads the webhook handler', async () => {
    const cfg = await load([...BASE, ...WEBHOOK_TELEGRAM]);
    const slice = sliceConfigForBot(cfg, 'telegram:alpha');
    if (!slice) throw new Error('slice missing');
    const order: string[] = [];
    const warnings: string[] = [];
    const mounts = live();

    const mounted = await startAndMountPlatformWebhook(
      webhookAdapter(order),
      slice,
      mounts,
      (message) => warnings.push(message),
    );

    // THE assertion. `start` is recorded when `start()` RESOLVES, and
    // `read-webhook` when the mount builder reads the handler off the adapter.
    // Invert the two statements inside `startAndMountPlatformWebhook` and this
    // becomes ['read-webhook', 'start'].
    expect(order).toEqual(['start', 'read-webhook']);
    expect(mounted.telegram).toEqual(['alpha']);
    expect(mounts.telegram.size).toBe(1);
    expect(warnings).toEqual([]);
  });

  it('control: mounting BEFORE start finds nothing, warns, and mounts nothing', async () => {
    // This is what the inverted order produces — the failure the assertion
    // above is guarding against, demonstrated rather than asserted about.
    const cfg = await load([...BASE, ...WEBHOOK_TELEGRAM]);
    const slice = sliceConfigForBot(cfg, 'telegram:alpha');
    if (!slice) throw new Error('slice missing');
    const order: string[] = [];
    const warnings: string[] = [];

    const mounts = buildPlatformWebhookMounts(slice, [webhookAdapter(order)], (m) =>
      warnings.push(m),
    );

    expect(order).toEqual(['read-webhook']);
    expect(mounts.telegram.size).toBe(0);
    expect(warnings[0]).toMatch(/no webhook handler/);
  });

  it('mounts nothing for a bot that is not in webhook mode, and does not warn', async () => {
    const cfg = await load([
      ...BASE,
      'telegram.bots.0.id: alpha',
      'telegram.bots.0.token: 111:alpha',
      'telegram.bots.0.bind.type: personality',
      'telegram.bots.0.bind.name: researcher',
      'channel_filter.telegram.ownerUserId: 42',
    ]);
    const slice = sliceConfigForBot(cfg, 'telegram:alpha');
    if (!slice) throw new Error('slice missing');
    const order: string[] = [];
    const warnings: string[] = [];
    const mounts = live();

    const mounted = await startAndMountPlatformWebhook(
      webhookAdapter(order),
      slice,
      mounts,
      (message) => warnings.push(message),
    );

    expect(order).toEqual(['start']);
    expect(mounted).toEqual({ telegram: [], slack: [] });
    expect(mounts.telegram.size).toBe(0);
    expect(warnings).toEqual([]);
  });
});

describe('unmountPlatformWebhook', () => {
  it('drops a telegram botKey and a slack route, and ignores an unmounted bot', () => {
    const mounts: PlatformWebhookMounts = {
      telegram: new Map([['alpha', () => {}]]),
      slack: new Map([['/slack/events/sales', () => {}]]),
    };
    const telegram = stubAdapter('telegram:alpha');
    const slack = Object.assign(stubAdapter('slack:sales'), {
      webhookRoute: '/slack/events/sales',
    });

    expect(unmountPlatformWebhook(mounts, telegram)).toEqual(['/telegram/webhook/alpha']);
    expect(unmountPlatformWebhook(mounts, slack)).toEqual(['/slack/events/sales']);
    expect(mounts.telegram.size).toBe(0);
    expect(mounts.slack.size).toBe(0);
    // A second removal, and a platform with no native webhook mode at all,
    // are both no-ops rather than errors.
    expect(unmountPlatformWebhook(mounts, telegram)).toEqual([]);
    expect(unmountPlatformWebhook(mounts, stubAdapter('whatsapp:wa1'))).toEqual([]);
  });

  it('keys slack off the adapter route rather than recomputing it', () => {
    const slack = Object.assign(stubAdapter('slack:sales'), { webhookRoute: '/custom/path' });
    expect(platformWebhookKeysFor(slack)).toEqual({ slack: '/custom/path' });
    // No route reported → nothing to unmount, and nothing guessed.
    expect(platformWebhookKeysFor(stubAdapter('slack:sales'))).toEqual({});
    expect(platformWebhookKeysFor(stubAdapter('telegram:alpha'))).toEqual({ telegram: 'alpha' });
  });
});

// ---------------------------------------------------------------------------
// The boot-side wiring, asserted against source (see the file header).
// ---------------------------------------------------------------------------

describe('boot.ts Phase C wiring (source assertions)', () => {
  const read = () => readFile(join(ROOT, 'apps/ethos/src/commands/boot.ts'), 'utf8');

  it('hands the webhook server the live route table, not a config snapshot', async () => {
    const src = await read();
    expect(src).toMatch(/const liveWebhooks: Record<string, WebhookHookConfig>/);
    expect(src).not.toMatch(/createWebhookServer\([\s\S]{0,120}cfg\.webhooks,/);
    expect(src).toMatch(/liveWebhooks\[hookId\] = prepared\.hook;/);
    expect(src).toMatch(/delete liveWebhooks\[hookId\];/);
  });

  it('starts a hot-added adapter and mounts its route as one sequence', async () => {
    const src = await read();
    const reconciler = src.slice(
      src.indexOf('--- Phase A reconciler'),
      src.indexOf("const configFilePath = join(dir, 'config.yaml');"),
    );
    expect(reconciler).toMatch(/await startAndMountPlatformWebhook\(/);
    // The bare `await adapter.start()` this replaced must be gone — a second
    // start path is how the ordering silently comes back apart.
    expect(reconciler).not.toMatch(/await adapter\.start\(\)/);
    expect(reconciler).toMatch(/unmountPlatformWebhook\(platformWebhookMounts, adapter\)/);
  });

  it('registers a hot-added webhook route as a gateway bot too', async () => {
    const src = await read();
    expect(src).toMatch(/gateway\.addBot\(prepared\.bot\)/);
    expect(src).toMatch(/await applyWebhookPlan\(plan\.webhooks, liveConfig\)/);
    // The route opens only once the bot is in the routing table, and a failure
    // anywhere closes it again — same transaction as a channel bot.
    expect(src).toMatch(/commitWebhookLive/);
    expect(src).toMatch(/register: \(\) => gateway\.addBot\(prepared\.bot\)/);
  });

  it('reads the adapter list live when building the initial mount table', async () => {
    const src = await read();
    expect(src).toMatch(/buildPlatformWebhookMounts\(cfg, gateway\.listAdapters\(\)/);
  });

  it('still does not smuggle Phase B in', async () => {
    const src = await read();
    expect(src).not.toMatch(/setChannelFilter/);
  });
});
