// plan/phases/webhook-subscriptions.md Phase 2 — the WIRING lane for delivery
// fan-out: config → adapter map → real `relayToTargets` → real ledger.
//
// Same two idioms as `gateway-platform-webhook-wiring.test.ts`:
//
//   - RUNTIME, for the whole chain. The relay seam this phase adds is built
//     INSIDE `runGatewayStart`, a ~700-line function that boots a process and
//     cannot be invoked from a unit test (`commands/gateway.ts` itself is
//     importable — `gateway-live-reload-webhooks.test.ts` imports from it —
//     but that one function is not callable). So this file ASSEMBLES the same
//     wiring the command builds, with nothing stubbed except the platform
//     adapter and the gateway turn, and drives it over real HTTP.
//   - SOURCE-TEXT, for the three facts about that assembly that only exist
//     inside `runGatewayStart`: it passes the relay, it keys the adapter map
//     by `adapter.id`, and it reuses the gateway's existing ledger rather than
//     constructing a second one.

import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { type EthosConfig, ethosDir, loadConfigStrict } from '@ethosagent/config';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { createCapturingAdapter, relayToTargets } from '@ethosagent/gateway';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { DeliveryResult, OutboundMessage, PlatformAdapter } from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWebhookServer,
  type DeliveryRelay,
  type WebhookGateway,
  type WebhookServer,
} from '../webhook-server';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const read = (rel: string) => readFile(join(ROOT, rel), 'utf8');

const BASE = ['provider: anthropic', 'model: claude-a', 'apiKey: sk-x', 'personality: researcher'];

async function load(lines: string[]): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), [...BASE, ...lines].join('\n'));
  const result = await loadConfigStrict(storage);
  if (!result) throw new Error('loadConfigStrict returned null');
  expect(result.parseErrors).toEqual([]);
  return result.config;
}

function fakeAdapter(id: string) {
  const sent: Array<{ chatId: string; message: OutboundMessage }> = [];
  const adapter = {
    id,
    displayName: id,
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    async start() {},
    async stop() {},
    async send(chatId: string, message: OutboundMessage): Promise<DeliveryResult> {
      sent.push({ chatId, message });
      return { ok: true, messageId: 'm1' };
    },
    onMessage() {},
    async health() {
      return { ok: true };
    },
  } as unknown as PlatformAdapter;
  return Object.assign(adapter, { sent });
}

let server: WebhookServer | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

/** The assembly `runGatewayStart` performs, verbatim in shape. */
function assembleWiring(opts: {
  config: EthosConfig;
  adapters: PlatformAdapter[];
  ledger: SQLiteDeliveryLedger;
  gateway: WebhookGateway;
}): Promise<number> {
  const adaptersById = new Map(opts.adapters.map((a) => [a.id, a]));
  const relay: DeliveryRelay = (targets, content, ctx) =>
    relayToTargets(targets, content, {
      hookId: ctx.hookId,
      sessionKey: ctx.sessionKey,
      adaptersById,
      ledger: opts.ledger,
      // `runGatewayStart` passes the console here; the assembly under test is
      // the shape, not the sink.
      log: () => {},
    });
  return new Promise((resolve) => {
    const s = createWebhookServer(
      0,
      '127.0.0.1',
      opts.gateway,
      opts.config.webhooks ?? {},
      createCapturingAdapter,
      undefined,
      relay,
    );
    server = s;
    s.once('listening', () => resolve((s.address() as AddressInfo).port));
  });
}

const post = (port: number, body: string) =>
  fetch(`http://127.0.0.1:${port}/webhook/hook1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer s3cret' },
    body,
  }).then(async (res) => ({ status: res.status, body: await res.text() }));

const neverCalledGateway: WebhookGateway = {
  handleMessage: async () => {
    throw new Error('deliverOnly must never dispatch a turn');
  },
};

describe('webhook delivery relay — end-to-end through the real relay and ledger', () => {
  it('delivers a deliverOnly payload to the adapter and marks the obligation delivered', async () => {
    const config = await load([
      'webhooks.hook1.personalityId: researcher',
      'webhooks.hook1.secret: s3cret',
      'webhooks.hook1.deliverOnly: true',
      'webhooks.hook1.deliver.0.type: platform',
      'webhooks.hook1.deliver.0.adapterId: telegram:tg-a',
      'webhooks.hook1.deliver.0.chatId: 12345',
    ]);
    const adapter = fakeAdapter('telegram:tg-a');
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const port = await assembleWiring({
      config,
      adapters: [adapter],
      ledger,
      gateway: neverCalledGateway,
    });

    const res = await post(port, '{"event":"push"}');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ delivered: [{ target: expect.anything(), ok: true }] });

    expect(adapter.sent).toEqual([{ chatId: '12345', message: { text: '{"event":"push"}' } }]);
    const rows = await ledger.listRecent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('delivered');
    // Owned by the TARGET adapter, so the boot sweep would recognise it.
    expect(rows[0]?.botKey).toBe('telegram:tg-a');
    expect(await ledger.listPending(['telegram:tg-a'])).toHaveLength(0);
  });

  it('fans an agent reply out to a platform target alongside the sync HTTP reply', async () => {
    const config = await load([
      'webhooks.hook1.personalityId: researcher',
      'webhooks.hook1.secret: s3cret',
      'webhooks.hook1.deliver.0.type: platform',
      'webhooks.hook1.deliver.0.adapterId: telegram:tg-a',
      'webhooks.hook1.deliver.0.chatId: 12345',
      'webhooks.hook1.deliver.0.threadId: t-7',
    ]);
    const adapter = fakeAdapter('telegram:tg-a');
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const port = await assembleWiring({
      config,
      adapters: [adapter],
      ledger,
      gateway: {
        handleMessage: async (_msg, capture) => {
          await capture.send('chat', { text: 'the agent reply' });
        },
      },
    });

    const res = await post(port, JSON.stringify({ prompt: 'hi' }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ reply: 'the agent reply' });

    // Detached from the response — wait for the fan-out to land.
    await expect.poll(() => adapter.sent.length, { timeout: 2000 }).toBe(1);
    expect(adapter.sent[0]).toEqual({
      chatId: '12345',
      message: { text: 'the agent reply', threadId: 't-7' },
    });
    await expect.poll(async () => (await ledger.listRecent(10))[0]?.status).toBe('delivered');
    expect((await ledger.listRecent(10))[0]?.threadId).toBe('t-7');
  });
});

describe('runGatewayStart wiring (source)', () => {
  it('passes the relay into createWebhookServer', async () => {
    const src = await read('apps/ethos/src/commands/gateway.ts');
    expect(src).toContain("relayToTargets,\n} from '@ethosagent/gateway';");
    expect(src).toMatch(/const relayWebhookTargets: DeliveryRelay =/);
    // Positional, right after the prefilter runner. Not anchored to the end of
    // the argument list any more — Phase 4 appended a trailing options object
    // (`onRejected`/`now`) behind it.
    expect(src).toMatch(/runWebhookPrefilter,\n\s*relayWebhookTargets,\n/);
  });

  it('keys the relay adapter map by adapter.id — what a deliver target names', async () => {
    const src = await read('apps/ethos/src/commands/gateway.ts');
    expect(src).toContain(
      'const webhookRelayAdapters = new Map(adapters.map((a) => [a.id, a as PlatformAdapter]));',
    );
  });

  it('reuses the gateway’s existing ledger rather than constructing a second one', async () => {
    const src = await read('apps/ethos/src/commands/gateway.ts');
    expect(src).toMatch(/adaptersById: webhookRelayAdapters,\n\s*ledger: deliveryLedger,/);
    // One reliability mechanism: exactly one ledger is constructed in this file.
    expect(src.match(/new SQLiteDeliveryLedger\(/g)).toHaveLength(1);
  });
});
