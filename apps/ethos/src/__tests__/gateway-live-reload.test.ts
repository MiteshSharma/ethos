// plan/phases/gateway-live-reload.md Phase A — the `apps/ethos` half: the
// config slice a hot-added bot is built from, the refusal rules that keep
// Phase A safe WITHOUT Phase B, and the WhatsApp pairing hazard from §3.
//
// `commands/boot.ts` imports `commands/serve.ts`, which imports
// `@ethosagent/acp-server` — an APP with no vitest alias, so boot.ts is not
// runtime-importable from a vitest run rooted at the repo. That is why the two
// pure decisions this phase turns on live in `config-reload.ts` (imported and
// executed for real below) and why the reconciler's own wiring is asserted
// against SOURCE, the same way every other boot-side suite does it.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type EthosConfig, ethosDir, loadConfigStrict } from '@ethosagent/config';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { type AdapterModuleLoader, buildAdapters } from '../commands/gateway';
import { hotAddRefusalReason, sliceConfigForBot } from '../config-reload';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

const BASE = ['provider: anthropic', 'model: claude-a', 'apiKey: sk-x', 'personality: researcher'];

const TELEGRAM = (n: string) => [
  `telegram.bots.${n === 'alpha' ? 0 : 1}.id: ${n}`,
  `telegram.bots.${n === 'alpha' ? 0 : 1}.token: 111:${n}`,
  `telegram.bots.${n === 'alpha' ? 0 : 1}.bind.type: personality`,
  `telegram.bots.${n === 'alpha' ? 0 : 1}.bind.name: researcher`,
];

async function load(lines: string[]): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), `${lines.join('\n')}\n`);
  const loaded = await loadConfigStrict(storage);
  if (!loaded) throw new Error('loadConfigStrict returned null');
  return loaded.config;
}

describe('sliceConfigForBot', () => {
  it('narrows a multi-bot config to exactly the named bot', async () => {
    const cfg = await load([
      ...BASE,
      ...TELEGRAM('alpha'),
      ...TELEGRAM('beta'),
      'slack.apps.0.id: sales',
      'slack.apps.0.botToken: xoxb-1',
      'slack.apps.0.signingSecret: sig',
      'slack.apps.0.bind.type: personality',
      'slack.apps.0.bind.name: researcher',
      'webhooks.hook1.personalityId: researcher',
      'webhooks.hook1.secret: s1',
    ]);
    const slice = sliceConfigForBot(cfg, 'telegram:beta');
    expect(slice?.telegram?.bots.map((b) => b.id)).toEqual(['beta']);
    // Every other bot-bearing block is cleared, so the shared builders return
    // exactly one bot and one adapter.
    expect(slice?.slack).toBeUndefined();
    expect(slice?.whatsapp).toBeUndefined();
    expect(slice?.webhooks).toBeUndefined();
    // Non-bot settings ride along untouched.
    expect(slice?.model).toBe('claude-a');
  });

  it('slices a slack app and a whatsapp entry', async () => {
    const cfg = await load([
      ...BASE,
      ...TELEGRAM('alpha'),
      'slack.apps.0.id: sales',
      'slack.apps.0.botToken: xoxb-1',
      'slack.apps.0.signingSecret: sig',
      'slack.apps.0.bind.type: personality',
      'slack.apps.0.bind.name: researcher',
      'whatsapp.0.id: wa1',
    ]);
    expect(sliceConfigForBot(cfg, 'slack:sales')?.slack?.apps.map((a) => a.id)).toEqual(['sales']);
    expect(sliceConfigForBot(cfg, 'slack:sales')?.telegram).toBeUndefined();
    expect(sliceConfigForBot(cfg, 'whatsapp:wa1')?.whatsapp?.map((w) => w.id)).toEqual(['wa1']);
  });

  it('returns undefined for an identity that names nothing', async () => {
    const cfg = await load([...BASE, ...TELEGRAM('alpha')]);
    expect(sliceConfigForBot(cfg, 'telegram:ghost')).toBeUndefined();
    expect(sliceConfigForBot(cfg, 'nonsense')).toBeUndefined();
  });
});

/**
 * The filter state a running gateway ACTUALLY has installed.
 *
 * `Gateway.channelFilter` is assigned at construction and Phase B — which
 * would replace it live — is deliberately not implemented, so the installed
 * set is whatever the process booted with, no matter what the file says now.
 * `Gateway.hasChannelFilterFor` is the real accessor; this is it, with the
 * boot-time platforms stated outright so each case is legible.
 */
const installed =
  (...platforms: string[]) =>
  (platform: string) =>
    platforms.includes(platform);

describe('hotAddRefusalReason — Phase A/C without Phase B', () => {
  it('refuses a bot with no channel_filter entry for its platform', async () => {
    const cfg = await load([...BASE, ...TELEGRAM('alpha')]);
    expect(hotAddRefusalReason(cfg, 'telegram:alpha', installed())).toMatch(
      /no channel_filter\.telegram/,
    );
  });

  it('refuses a bot whose platform has a filter for a DIFFERENT platform only', async () => {
    const cfg = await load([...BASE, ...TELEGRAM('alpha'), 'channel_filter.slack.ownerUserId: U1']);
    expect(hotAddRefusalReason(cfg, 'telegram:alpha', installed('slack'))).toMatch(
      /no channel_filter\.telegram/,
    );
  });

  it('accepts a bot whose platform filter was installed at startup', async () => {
    const cfg = await load([
      ...BASE,
      ...TELEGRAM('alpha'),
      'channel_filter.telegram.ownerUserId: 42',
    ]);
    expect(hotAddRefusalReason(cfg, 'telegram:alpha', installed('telegram'))).toBeNull();
  });

  // THE SECURITY CASE. A bot and its `channel_filter` block arrive in the SAME
  // edit: the file names a filter, the running gateway has none installed, and
  // nothing installs one live (that is Phase B). Reading the FILE here would
  // put the bot live under access control that was never in force.
  it('refuses a bot added in the same edit as its channel_filter, naming the restart', async () => {
    const cfg = await load([
      ...BASE,
      ...TELEGRAM('alpha'),
      'channel_filter.telegram.ownerUserId: 42',
    ]);
    const refusal = hotAddRefusalReason(cfg, 'telegram:alpha', installed());
    expect(refusal).not.toBeNull();
    expect(refusal).toMatch(/NOT installed in the running gateway/);
    expect(refusal).toMatch(/restart/);
  });

  it('says a restart is required even when no filter is in the file at all', async () => {
    const cfg = await load([...BASE, ...TELEGRAM('alpha')]);
    expect(hotAddRefusalReason(cfg, 'telegram:alpha', installed())).toMatch(/restart/);
  });

  // The same edit on a platform that already had one: adding a SECOND telegram
  // bot under a filter installed at boot is the ordinary hot-add, and stays
  // allowed. Only a filter that is new to the RUNNING process blocks.
  it('still accepts a second bot on a platform whose filter was installed', async () => {
    const cfg = await load([
      ...BASE,
      ...TELEGRAM('alpha'),
      ...TELEGRAM('beta'),
      'channel_filter.telegram.ownerUserId: 42',
    ]);
    expect(hotAddRefusalReason(cfg, 'telegram:beta', installed('telegram'))).toBeNull();
  });

  it('accepts a webhook-mode bot now that Phase C mounts its route', async () => {
    const telegram = await load([
      ...BASE,
      ...TELEGRAM('alpha'),
      'telegram.bots.0.useWebhook: true',
      'telegram.bots.0.webhookUrl: https://example.test/tg',
      'channel_filter.telegram.ownerUserId: 42',
    ]);
    expect(hotAddRefusalReason(telegram, 'telegram:alpha', installed('telegram'))).toBeNull();

    const slack = await load([
      ...BASE,
      'slack.apps.0.id: sales',
      'slack.apps.0.botToken: xoxb-1',
      'slack.apps.0.signingSecret: sig',
      'slack.apps.0.mode.http: true',
      'slack.apps.0.bind.type: personality',
      'slack.apps.0.bind.name: researcher',
      'channel_filter.slack.ownerUserId: U1',
    ]);
    expect(hotAddRefusalReason(slack, 'slack:sales', installed('slack'))).toBeNull();
  });

  it('refuses an identity that names nothing in the reloaded config', async () => {
    const cfg = await load([...BASE, 'channel_filter.telegram.ownerUserId: 42']);
    expect(hotAddRefusalReason(cfg, 'telegram:ghost', installed('telegram'))).toMatch(
      /no matching entry/,
    );
  });
});

describe('WhatsApp pairing outside cold boot (§3 hazard)', () => {
  it('threads onQr / onPairingCode into an adapter built from a one-bot slice', async () => {
    const cfg = await load([
      ...BASE,
      'whatsapp.0.id: wa1',
      'channel_filter.whatsapp.ownerUserId: 1',
    ]);
    const slice = sliceConfigForBot(cfg, 'whatsapp:wa1');
    if (!slice) throw new Error('slice missing');

    let captured: {
      onQr?: (qr: string | null) => void;
      onPairingCode?: (code: string | null) => void;
    } = {};
    const loader: AdapterModuleLoader = (async (name: string) =>
      name === '@ethosagent/platform-whatsapp'
        ? {
            WhatsAppAdapter: class {
              constructor(c: Record<string, unknown>) {
                captured = c as typeof captured;
                Object.assign(this, {
                  id: 'whatsapp:wa1',
                  displayName: 'whatsapp',
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
                } satisfies PlatformAdapter);
              }
            },
          }
        : null) as unknown as AdapterModuleLoader;

    const qrs: Array<[string, string | null]> = [];
    const codes: Array<[string, string | null]> = [];
    const adapters = await buildAdapters(slice, loader, undefined, {
      onWhatsAppQr: (botId, qr) => qrs.push([botId, qr]),
      onWhatsAppPairingCode: (botId, code) => codes.push([botId, code]),
    });
    expect(adapters).toHaveLength(1);

    // These are the callbacks `buildGatewayAdapters` points at web-api's
    // `setWhatsAppQr` / `setWhatsAppPairingCode`. They are plain setters keyed
    // by botId with no boot-time state, so firing them long after boot — as a
    // hot-added bot does — behaves identically.
    captured.onQr?.('qr-payload');
    captured.onPairingCode?.('12345678');
    captured.onQr?.(null);
    expect(qrs).toEqual([
      ['wa1', 'qr-payload'],
      ['wa1', null],
    ]);
    expect(codes).toEqual([['wa1', '12345678']]);
  });
});

describe('boot.ts reconciler wiring (source assertions)', () => {
  const read = () => readFile(join(ROOT, 'apps/ethos/src/commands/boot.ts'), 'utf8');

  it('applies the outstanding bots work through addAdapter / removeAdapter', async () => {
    const src = await read();
    // Driven from the APPLIED ledger, not from the parsed file: a unit only
    // leaves the plan once its own reconcile returned.
    expect(src).toMatch(/const plan = planReconcile\(applied, liveConfig\)/);
    expect(src).toMatch(/await applyBotPlan\(plan\.bots, liveConfig\)/);
    expect(src).toMatch(/gateway\.addAdapter\(adapter, bot\)/);
    expect(src).toMatch(/await gateway\.removeAdapter\(botKey\)/);
    // A `changed` bot is BUILT before the old one is retired, and restored if
    // the replacement fails to commit — never blind remove-then-add.
    expect(src).toMatch(/await swapBotLive\(\{/);
    expect(src).toMatch(/prepare: \(\) => prepareBotLive\(id, source\)/);
    expect(src).toMatch(/retire: \(\) => retireBotTransport\(id\)/);
    expect(src).not.toMatch(/plan\.removed, \.\.\.plan\.changed/);
  });

  it('marks a unit applied only after its own reconcile returned', async () => {
    const src = await read();
    // The old shape assigned one whole-config snapshot before applying
    // anything, which recorded every failure as applied.
    expect(src).not.toMatch(/lastAppliedConfig = next\.config/);
    const pairs: Array<[string, string]> = [
      ['await addBotLive(id, source);', "markApplied(applied, source, 'bot', id);"],
      ['await removeBotLive(id);', "markRetired(applied, 'bot', id);"],
      ['await changeBotLive(id, source);', "markApplied(applied, source, 'bot', id);"],
    ];
    for (const [call, mark] of pairs) {
      const at = src.indexOf(call);
      expect(at).toBeGreaterThan(0);
      expect(src.slice(at, at + 200)).toContain(mark);
    }
    // A failure keeps the unit pending, and pending outranks the mtime gate.
    expect(src).toMatch(/reconcilePending\(applied, liveConfig\)/);
    expect(src).toMatch(
      /shouldReloadConfig\(\{ mtimeMs, lastMtimeMs: lastConfigMtimeMs, pending \}\)/,
    );
  });

  it('registers a hot-added bot as one transaction, with a rollback', async () => {
    const src = await read();
    expect(src).toMatch(/await commitHotAdd\(\{/);
    expect(src).toMatch(/deregister: \(\) => gateway\.removeAdapter\(bot\.botKey\)/);
    expect(src).toMatch(/onRollbackError:/);
  });

  it('keys clarify correlators by bot and drops a removed one', async () => {
    const src = await read();
    expect(src).toMatch(/const clarifyCorrelators = createClarifyCorrelatorRegistry\(\)/);
    // Never an append-only array again.
    expect(src).not.toMatch(/clarifyCorrelators\.push/);
    expect(src).toMatch(/clarifyCorrelators\.set\(botKey, correlate\)/);
    expect(src).toMatch(/clarifyCorrelators\.delete\(bot\.botKey, correlator\)/);
  });

  it('reads the adapter and bot lists live rather than from a boot-time snapshot', async () => {
    const src = await read();
    expect(src).not.toMatch(/let liveAdapters/);
    expect(src).toMatch(/gatewayRef\?\.listAdapters\(\) \?\? \[\]/);
    expect(src).toMatch(/gateway\.listBots\(\)/);
  });

  it('refuses a bad hot-add instead of exiting, and keeps the cold-boot gate fatal', async () => {
    const src = await read();
    // The cold-boot gate is unchanged: both fatal branches still hard-exit.
    expect(src).toMatch(
      /FATAL: Channel adapters configured without channel_filter safety config[\s\S]*?process\.exit\(1\)/,
    );
    expect(src).toMatch(/has no channel_filter\.\$\{platform\} config[\s\S]*?process\.exit\(1\)/);
    // The runtime path refuses one unit by name and never exits.
    expect(src).toMatch(/\$\{kind\} "\$\{id\}" not applied/);
    const reconciler = src.slice(
      src.indexOf('--- Phase A reconciler'),
      src.indexOf("const configFilePath = join(dir, 'config.yaml');"),
    );
    expect(reconciler.length).toBeGreaterThan(500);
    const code = reconciler
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/process\.exit/);
  });

  it('wires cold-booted and hot-added bots through ONE call and ONE registry', async () => {
    const src = await read();
    // Cold boot registers PER BOT, through the same `registerBotLive` a hot-add
    // uses, into the same `botWiring` map — so replacing a bot that has been
    // there since boot finds a teardown handle to run.
    expect(src).toMatch(
      /for \(const bot of bots\) \{[\s\S]{0,500}?botWiring\.set\(bot\.botKey, await registerBotLive\(bot, wiring,/,
    );
    // The two-shapes-of-bot state that caused the leak is gone entirely.
    expect(src).not.toMatch(/hotBotWiring/);
    expect(src).not.toMatch(/hotApprovalFlows/);
    expect(src).not.toMatch(/coldBotKeys/);
    // A replacement takes the slot BEFORE the outgoing handle runs.
    expect(src).toMatch(/replaceBotWiring\(botWiring, botKey, undoWiring\)/);
  });

  it('retires a removed bot\u2019s TRANSPORT before it undoes its wiring', async () => {
    const src = await read();
    // A drain that outlives the abort grace leaves the bot QUARANTINED and
    // still fully wired, and `removeAdapter` throws so a later poll retries.
    // Undoing the wiring first dismantled the approval flow, correlator,
    // routers, messaging bindings and refreshers of a bot that was still
    // running a turn on them — and deleted the handle the retry needed.
    expect(src).toMatch(/retireBotFully\(botWiring, botKey, \(\) => retireBotTransport\(id\)\)/);
    expect(src).toMatch(
      /retireBotFully\(botWiring, `webhook:\$\{hookId\}`, \(\) => retireWebhookTransport\(hookId\)\)/,
    );
    // The inverted order is gone from both removal paths.
    expect(src).not.toMatch(/botWiring\.delete\(botKey\);/);
    expect(src).not.toMatch(/await undoWiring\?\.\(\);/);
  });

  it('rolls a failed replacement back by REBUILDING, not by restarting the retired adapter', async () => {
    const src = await read();
    expect(src).toMatch(
      /rebuildPrevious: \(\) => \{[\s\S]{0,400}?prepareBotLive\(id, appliedSliceOrRefuse\('bot', id\)\)/,
    );
    expect(src).toMatch(/prepareWebhookLive\(hookId, appliedSliceOrRefuse\('webhook', hookId\)\)/);
    // The pre-fix rollback: re-register and re-start the object `retire` had
    // already stopped. `PlatformAdapter` makes no promise that works.
    expect(src).not.toMatch(/gateway\.addAdapter\(previousAdapter, previousBot\)/);
    expect(src).not.toMatch(/previousAdapter/);
    expect(src).not.toMatch(/restore: async \(\) => \{/);
  });

  it('gives the idle watcher a live bot list rather than a static/hot split', async () => {
    const src = await read();
    expect(src).toMatch(/createLiveBotBusySource\(\(\) => gateway\.listBots\(\)\)/);
    // A replaced bot keeps its botKey, so splitting by key lost it from both
    // halves and the process could suspend with its work in flight.
    expect(src).not.toMatch(/hotBots\(\)/);
  });

  it('asks the RUNNING gateway for the installed filter, not the parsed file', async () => {
    const src = await read();
    // The security fix: `hotAddRefusalReason` is handed
    // `Gateway.hasChannelFilterFor`, so a `channel_filter` block that arrived
    // in the same edit as the bot cannot admit it.
    expect(src).toMatch(
      /hotAddRefusalReason\(source, id, \(platform\) =>[\s\S]{0,80}?gateway\.hasChannelFilterFor\(platform\)/,
    );
    // Never the config object the diff just parsed.
    expect(src).not.toMatch(/hotAddRefusalReason\(source, id\)/);
  });

  it('rebuilds a failed replacement from the APPLIED slice, not the parsed file', async () => {
    const src = await read();
    expect(src).toMatch(/prepareBotLive\(id, appliedSliceOrRefuse\('bot', id\)\)/);
    expect(src).toMatch(/prepareWebhookLive\(hookId, appliedSliceOrRefuse\('webhook', hookId\)\)/);
    // The whole-file rollback source is gone: it could name a version that was
    // never live once one unit failed to apply.
    expect(src).not.toMatch(/previousConfig/);
  });

  it('stops and AWAITS the reload before shutdown tears down what it manages', async () => {
    const src = await read();
    expect(src).toMatch(/createReloadRunner\(reloadConfig,/);
    const at = src.indexOf("await guard('config-reload'");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 200)).toContain('await configReloadRunner.stop()');
    // …and it runs BEFORE every step that tears down a reload-managed resource.
    expect(at).toBeLessThan(src.indexOf("'web-server',"));
    expect(at).toBeLessThan(src.indexOf("await guard('adapters'"));
    expect(at).toBeLessThan(src.indexOf("await guard('platform-webhook-server'"));
    // A bare `clearInterval` alone is what let a running reconcile outlive it.
    expect(src).not.toMatch(/^\s*clearInterval\(configReloadTimer\);\n\s*clearInterval\(a2a/m);
  });

  it('releases a webhook listener whose last route is gone', async () => {
    const src = await read();
    expect(src).toMatch(/const releaseWebhookServerIfIdle = \(\): void =>/);
    expect(src).toMatch(/const releasePlatformWebhookServerIfIdle = \(\): void =>/);
    // Called from the reconcile tail, so every path that empties a route table
    // is covered by one call rather than each removal remembering to.
    const at = src.indexOf(
      'releaseWebhookServerIfIdle();\n      releasePlatformWebhookServerIfIdle();',
    );
    expect(at).toBeGreaterThan(0);
    expect(src.indexOf('await applyWebhookPlan(plan.webhooks, liveConfig)')).toBeLessThan(at);
  });

  it('does not smuggle Phase B in: no setChannelFilter anywhere', async () => {
    const src = await read();
    expect(src).not.toMatch(/setChannelFilter/);
    const gatewaySrc = await readFile(join(ROOT, 'extensions/gateway/src/index.ts'), 'utf8');
    expect(gatewaySrc).not.toMatch(/setChannelFilter/);
  });
});
