// plan/phases/telegram-slack-webhook-mode.md §2a, §2b, §3b, §3c, §4, §5, §9 —
// the WIRING lane: config → adapter constructor → dispatch map → shared server.
//
// The adapters themselves and the shared server both have their own runtime
// suites (`extensions/platform-telegram/src/__tests__/webhook.test.ts`,
// `extensions/platform-slack/src/__tests__/webhook-mode.test.ts`,
// `apps/ethos/src/__tests__/platform-webhook-server.test.ts`). What was still
// untested is the seam between them, which is exactly where §1's gap lived:
// fields that exist at the adapter layer and are never populated.
//
// Two idioms, deliberately:
//
//  - RUNTIME, for everything reachable. `buildAdapters` and
//    `buildPlatformWebhookMounts` are both exported from `commands/gateway.ts`
//    and both take their collaborators as arguments, so the whole config →
//    constructor → map chain runs for real against a stub module loader (the
//    same harness `gateway-build-adapters.test.ts` established, so no live
//    grammy / @slack/bolt construction is needed).
//  - SOURCE-TEXT, for the four facts that live inside `runGatewayStart` — a
//    ~700-line function that boots an entire process and cannot be invoked
//    from a unit test. `boot-profile-command.test.ts` and its siblings already
//    assert against source for this exact reason. Refactoring `gateway.ts` to
//    make them reachable is scope this plan does not authorise.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  type AdapterModuleLoader,
  buildAdapters,
  buildPlatformWebhookMounts,
} from '../commands/gateway';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const read = (rel: string) => readFile(join(ROOT, rel), 'utf8');

interface CapturedAdapter extends PlatformAdapter {
  readonly capturedConfig: Record<string, unknown>;
}

const capturedOf = (a: PlatformAdapter): Record<string, unknown> =>
  (a as CapturedAdapter).capturedConfig;

/**
 * Stub adapters that mimic the ONE lifecycle detail this wiring depends on:
 * `TelegramAdapter.webhook` is `undefined` until `start()` has built grammy's
 * callback, while `SlackAdapter.requestListener` / `.webhookRoute` are
 * available from construction. If `buildPlatformWebhookMounts` were ever
 * called before `adapter.start()`, the Telegram half would silently come back
 * empty — so the stubs reproduce that asymmetry rather than papering over it.
 */
function makeStub(name: string, cfg: Record<string, unknown>): CapturedAdapter {
  const botKey = cfg.botKey as string | undefined;
  const httpMode = (cfg.mode as { http?: boolean } | undefined)?.http === true;
  const segment = (cfg.webhookPath as string | undefined) ?? botKey;
  let webhook: ((req: unknown, res: unknown) => Promise<void>) | undefined;
  const adapter = {
    id: botKey ? `${name}:${botKey}` : name,
    displayName: name,
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    capturedConfig: cfg,
    async start() {
      if (name === 'telegram' && cfg.useWebhook === true) {
        webhook = async () => {};
      }
    },
    async stop() {},
    async send() {
      return { ok: true };
    },
    onMessage(_h: (m: InboundMessage) => void) {},
    async health() {
      return { ok: true };
    },
    // Telegram: absent until start().
    get webhook() {
      return webhook;
    },
    // Slack: present from construction, in http mode only.
    requestListener: name === 'slack' && httpMode ? () => {} : undefined,
    webhookRoute: name === 'slack' && httpMode ? `/slack/events/${segment}` : undefined,
  };
  return adapter as unknown as CapturedAdapter;
}

/** Copy a stub onto `this`, getters included. */
function adopt(target: object, stub: CapturedAdapter): void {
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(stub));
}

function makeLoader(): AdapterModuleLoader {
  const MODULES: Record<string, unknown> = {
    // Property DESCRIPTORS, not `Object.assign` (the idiom in
    // `gateway-build-adapters.test.ts`): `Object.assign` INVOKES the `webhook`
    // getter and copies its value, freezing it at the pre-`start()`
    // `undefined` and making the lifecycle asymmetry untestable.
    '@ethosagent/platform-telegram': {
      TelegramAdapter: class {
        constructor(cfg: Record<string, unknown>) {
          adopt(this, makeStub('telegram', cfg));
        }
      },
    },
    '@ethosagent/platform-slack': {
      SlackAdapter: class {
        constructor(cfg: Record<string, unknown>) {
          adopt(this, makeStub('slack', cfg));
        }
      },
    },
  };
  return async <T>(modulePath: string): Promise<T | null> =>
    (MODULES[modulePath] ?? null) as T | null;
}

const baseConfig: EthosConfig = {
  provider: 'anthropic',
  model: 'claude-opus-4-7',
  apiKey: 'sk',
  personality: 'researcher',
};

const startAll = (adapters: PlatformAdapter[]) => Promise.all(adapters.map((a) => a.start()));

// ---------------------------------------------------------------------------
// §9 "Default-preserving test" — the most important one in this lane.
// ---------------------------------------------------------------------------

describe('§9 default-preserving — no new config key set anywhere', () => {
  it('constructs the Telegram adapter with no useWebhook and the Slack adapter in Socket Mode', async () => {
    const adapters = await buildAdapters(
      {
        ...baseConfig,
        telegram: {
          bots: [{ id: 'tg', token: '1:t', bind: { type: 'personality', name: 'researcher' } }],
        },
        slack: {
          apps: [
            {
              id: 'sl',
              botToken: 'xoxb',
              appToken: 'xapp',
              signingSecret: 'sig',
              bind: { type: 'personality', name: 'researcher' },
            },
          ],
        },
      },
      makeLoader(),
    );

    const telegram = capturedOf(adapters[0]);
    // Not `false` — absent. The adapter's own `!!this.config.useWebhook` and
    // the long-poll `else` branch are what today's deployments run.
    expect(telegram).not.toHaveProperty('useWebhook');
    expect(telegram).not.toHaveProperty('webhookUrl');
    expect(telegram).not.toHaveProperty('webhookSecretToken');
    // Passed through as `undefined`, which the adapter resolves to `true` via
    // its own `?? true`. Same effective long-poll behaviour as the hardcoded
    // literal this replaced — see the `dropPendingUpdates` block below.
    expect(telegram.dropPendingUpdates).toBeUndefined();

    const slack = capturedOf(adapters[1]);
    expect(slack).not.toHaveProperty('mode');
    expect(slack).not.toHaveProperty('webhookPath');
    expect(slack.appToken).toBe('xapp');
  });

  it('mounts nothing, so no platform webhook port is ever bound', async () => {
    const config: EthosConfig = {
      ...baseConfig,
      telegram: {
        bots: [{ id: 'tg', token: '1:t', bind: { type: 'personality', name: 'researcher' } }],
      },
      slack: {
        apps: [
          {
            id: 'sl',
            botToken: 'xoxb',
            appToken: 'xapp',
            signingSecret: 'sig',
            bind: { type: 'personality', name: 'researcher' },
          },
        ],
      },
    };
    const adapters = await buildAdapters(config, makeLoader());
    await startAll(adapters);

    const warnings: string[] = [];
    const mounts = buildPlatformWebhookMounts(config, adapters, (m) => warnings.push(m));

    // The gate `runGatewayStart` reads: both empty ⇒ `createPlatformWebhookServer`
    // is never called and nothing listens.
    expect(mounts.telegram.size).toBe(0);
    expect(mounts.slack.size).toBe(0);
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §9 Telegram config plumbing + the dropPendingUpdates regression.
// ---------------------------------------------------------------------------

describe('§2a Telegram webhook config reaches the adapter constructor', () => {
  it('threads useWebhook / webhookUrl / webhookSecretToken through', async () => {
    const adapters = await buildAdapters(
      {
        ...baseConfig,
        telegram: {
          bots: [
            {
              id: 'tg',
              token: '1:t',
              bind: { type: 'personality', name: 'researcher' },
              useWebhook: true,
              webhookUrl: 'https://ethos.example/telegram/webhook/tg',
              webhookSecretToken: 'shhh',
            },
          ],
        },
      },
      makeLoader(),
    );

    expect(capturedOf(adapters[0])).toMatchObject({
      token: '1:t',
      botKey: 'tg',
      useWebhook: true,
      webhookUrl: 'https://ethos.example/telegram/webhook/tg',
      webhookSecretToken: 'shhh',
    });
  });

  it('threads an explicit useWebhook: false through rather than dropping it', async () => {
    const adapters = await buildAdapters(
      {
        ...baseConfig,
        telegram: {
          bots: [
            {
              id: 'tg',
              token: '1:t',
              bind: { type: 'personality', name: 'researcher' },
              useWebhook: false,
            },
          ],
        },
      },
      makeLoader(),
    );
    expect(capturedOf(adapters[0]).useWebhook).toBe(false);
  });

  it('threads a non-default dropPendingUpdates: false from config (regression — was hardcoded `true`)', async () => {
    const adapters = await buildAdapters(
      {
        ...baseConfig,
        telegram: {
          bots: [
            {
              id: 'tg',
              token: '1:t',
              bind: { type: 'personality', name: 'researcher' },
              dropPendingUpdates: false,
            },
          ],
        },
      },
      makeLoader(),
    );
    // Before this lane the construction site passed the literal `true`, so an
    // operator's `false` was silently discarded and every queued update was
    // dropped on restart anyway.
    expect(capturedOf(adapters[0]).dropPendingUpdates).toBe(false);
  });

  it('does not double-default dropPendingUpdates — the adapter owns the `?? true`', async () => {
    const src = await read('apps/ethos/src/commands/gateway.ts');
    expect(src).toMatch(/dropPendingUpdates: botCfg\.dropPendingUpdates,/);
    expect(src).not.toMatch(/dropPendingUpdates: botCfg\.dropPendingUpdates \?\?/);
  });
});

// ---------------------------------------------------------------------------
// §9 Slack config plumbing.
// ---------------------------------------------------------------------------

describe('§3b Slack transport config reaches the adapter constructor', () => {
  it('threads mode and webhookPath through', async () => {
    const adapters = await buildAdapters(
      {
        ...baseConfig,
        slack: {
          apps: [
            {
              id: 'sl',
              botToken: 'xoxb',
              signingSecret: 'sig',
              bind: { type: 'personality', name: 'researcher' },
              mode: { http: true },
              webhookPath: 'events-prod',
            },
          ],
        },
      },
      makeLoader(),
    );

    expect(capturedOf(adapters[0])).toMatchObject({
      botToken: 'xoxb',
      signingSecret: 'sig',
      botKey: 'sl',
      mode: { http: true },
      webhookPath: 'events-prod',
    });
  });

  it('constructs an HTTP-mode app that has no appToken at all', async () => {
    const adapters = await buildAdapters(
      {
        ...baseConfig,
        slack: {
          apps: [
            {
              id: 'sl',
              botToken: 'xoxb',
              signingSecret: 'sig',
              bind: { type: 'personality', name: 'researcher' },
              mode: { socket: false, http: true },
            },
          ],
        },
      },
      makeLoader(),
    );
    expect(adapters).toHaveLength(1);
    expect(capturedOf(adapters[0]).appToken).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §2b / §3c — the dispatch maps.
// ---------------------------------------------------------------------------

describe('buildPlatformWebhookMounts', () => {
  const webhookConfig: EthosConfig = {
    ...baseConfig,
    telegram: {
      bots: [
        {
          id: 'tg-a',
          token: '1:a',
          bind: { type: 'personality', name: 'researcher' },
          useWebhook: true,
          webhookUrl: 'https://ethos.example/telegram/webhook/tg-a',
          webhookSecretToken: 'a',
        },
        // Long-poll bot sharing the process — must NOT be mounted.
        { id: 'tg-b', token: '2:b', bind: { type: 'personality', name: 'coder' } },
      ],
    },
    slack: {
      apps: [
        {
          id: 'sl-a',
          botToken: 'xoxb-a',
          signingSecret: 'sig-a',
          bind: { type: 'personality', name: 'researcher' },
          mode: { http: true },
        },
        // Socket-mode app sharing the process — must NOT be mounted.
        {
          id: 'sl-b',
          botToken: 'xoxb-b',
          appToken: 'xapp-b',
          signingSecret: 'sig-b',
          bind: { type: 'personality', name: 'coder' },
        },
      ],
    },
  };

  it('populates both maps with the right keys, and only for bots that asked', async () => {
    const adapters = await buildAdapters(webhookConfig, makeLoader());
    await startAll(adapters);
    const warnings: string[] = [];
    const mounts = buildPlatformWebhookMounts(webhookConfig, adapters, (m) => warnings.push(m));

    // Telegram is keyed by botKey; the server appends it to
    // `/telegram/webhook/`.
    expect([...mounts.telegram.keys()]).toEqual(['tg-a']);
    // Slack is keyed by the FULL route the adapter reports, never recomputed.
    expect([...mounts.slack.keys()]).toEqual(['/slack/events/sl-a']);
    expect(typeof mounts.telegram.get('tg-a')).toBe('function');
    expect(typeof mounts.slack.get('/slack/events/sl-a')).toBe('function');
    expect(warnings).toEqual([]);
  });

  it('keys Slack by the adapter’s webhookPath override rather than its botKey', async () => {
    const config: EthosConfig = {
      ...baseConfig,
      slack: {
        apps: [
          {
            id: 'sl',
            botToken: 'xoxb',
            signingSecret: 'sig',
            bind: { type: 'personality', name: 'researcher' },
            mode: { http: true },
            webhookPath: 'events-prod',
          },
        ],
      },
    };
    const adapters = await buildAdapters(config, makeLoader());
    await startAll(adapters);
    const mounts = buildPlatformWebhookMounts(config, adapters, () => {});
    expect([...mounts.slack.keys()]).toEqual(['/slack/events/events-prod']);
  });

  it('warns and registers nothing when a webhook-mode Telegram bot exposes no handler', async () => {
    const config: EthosConfig = {
      ...baseConfig,
      telegram: {
        bots: [
          {
            id: 'tg-broken',
            token: '1:t',
            bind: { type: 'personality', name: 'researcher' },
            useWebhook: true,
            webhookUrl: 'https://ethos.example/telegram/webhook/tg-broken',
            webhookSecretToken: 's',
          },
        ],
      },
    };
    const adapters = await buildAdapters(config, makeLoader());
    // Deliberately NOT started — this is exactly the shape a caller that built
    // the maps too early would produce, and the shape a real adapter whose
    // `setWebhook` failed would leave behind.
    const warnings: string[] = [];
    const mounts = buildPlatformWebhookMounts(config, adapters, (m) => warnings.push(m));

    expect(mounts.telegram.size).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('tg-broken');
    expect(warnings[0]).toContain('use_webhook');
  });

  it('resolves the same derived botKey the adapters were built on when `id` is omitted', async () => {
    const config: EthosConfig = {
      ...baseConfig,
      telegram: {
        bots: [
          {
            token: '123:ABC',
            bind: { type: 'personality', name: 'researcher' },
            useWebhook: true,
            webhookUrl: 'https://ethos.example/telegram/webhook/x',
            webhookSecretToken: 's',
          },
        ],
      },
    };
    const adapters = await buildAdapters(config, makeLoader());
    await startAll(adapters);
    const warnings: string[] = [];
    const mounts = buildPlatformWebhookMounts(config, adapters, (m) => warnings.push(m));

    expect(warnings).toEqual([]);
    expect([...mounts.telegram.keys()]).toEqual([adapters[0].id.replace('telegram:', '')]);
  });
});

// ---------------------------------------------------------------------------
// Inside `runGatewayStart` — source-text, per the file header's reasoning.
// ---------------------------------------------------------------------------

describe('runGatewayStart wiring (source)', () => {
  it('builds the mounts AFTER every adapter has been started', async () => {
    const src = await read('apps/ethos/src/commands/gateway.ts');
    const startedAt = src.indexOf('await Promise.all(adapters.map((a) => a.start()));');
    const mountedAt = src.indexOf('buildPlatformWebhookMounts(config, adapters');
    expect(startedAt).toBeGreaterThan(-1);
    expect(mountedAt).toBeGreaterThan(-1);
    // `TelegramAdapter.webhook` is undefined until start() — the reverse order
    // mounts nothing and 404s every delivery.
    expect(mountedAt).toBeGreaterThan(startedAt);
  });

  it('starts the server only when at least one bot or app needs it', async () => {
    const src = await read('apps/ethos/src/commands/gateway.ts');
    expect(src).toContain(
      'if (platformWebhookMounts.telegram.size > 0 || platformWebhookMounts.slack.size > 0) {',
    );
  });

  it('resolves port 3006 and the shared serve host, matching the sibling servers', async () => {
    const src = await read('apps/ethos/src/commands/gateway.ts');
    expect(src).toContain(
      'const platformWebhookPort = Number(process.env.ETHOS_PLATFORM_WEBHOOK_PORT) || 3006;',
    );
    expect(src).toContain(
      "const platformWebhookHost = process.env.ETHOS_SERVE_HOST ?? '127.0.0.1';",
    );
    // 3004 is ETHOS_RUNALL_HEALTH_PORT and run-all spawns this process.
    expect(src).not.toContain('ETHOS_PLATFORM_WEBHOOK_PORT) || 3004');
  });

  it('closes the server alongside the other webhook servers on shutdown', async () => {
    const src = await read('apps/ethos/src/commands/gateway.ts');
    expect(src).toMatch(
      /webhookServer\?\.close\(\);\s*\n\s*sipWebhookServer\?\.close\(\);\s*\n\s*platformWebhookServer\?\.close\(\);/,
    );
  });
});

// ---------------------------------------------------------------------------
// `ethos boot` — the merged single-process profile. Same source-text idiom and
// the same four facts as `runGatewayStart` above, because the failure this
// guards against is SILENT: `boot.ts` shares `buildGatewayAdapters` with
// `runGatewayStart`, so a bot with `use_webhook` boots identically under both
// and calls `setWebhook()` against Telegram either way. Without a listener,
// that registers a public URL against a port nothing is bound to — every
// inbound message 404s and the process logs nothing to say why. A missing
// mount here is not a missing feature, it is a broken channel that looks fine.
// ---------------------------------------------------------------------------

describe('runBoot wiring — parity with runGatewayStart (source)', () => {
  it('builds the mounts AFTER every adapter has been started', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    const startedAt = src.indexOf('await Promise.all(adapters.map((a) => a.start()));');
    const mountedAt = src.indexOf('buildPlatformWebhookMounts(cfg, gateway.listAdapters()');
    expect(startedAt).toBeGreaterThan(-1);
    expect(mountedAt).toBeGreaterThan(-1);
    // Same ordering constraint as the gateway: `TelegramAdapter.webhook` is
    // undefined until start(), so the reverse order mounts nothing.
    expect(mountedAt).toBeGreaterThan(startedAt);
  });

  it('starts the server only when at least one bot or app needs it', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    // The gate moved inside `ensurePlatformWebhookServer` with Phase C — the
    // same listener is now bound on demand, either at boot or when a live
    // config edit mounts the first route — but the rule is unchanged: no
    // mounted route, no bound port.
    expect(src).toContain(
      'if (platformWebhookMounts.telegram.size === 0 && platformWebhookMounts.slack.size === 0) return;',
    );
  });

  it('resolves the same port and host as runGatewayStart, not a second convention', async () => {
    const boot = await read('apps/ethos/src/commands/boot.ts');
    const gateway = await read('apps/ethos/src/commands/gateway.ts');
    const portLine =
      'const platformWebhookPort = Number(process.env.ETHOS_PLATFORM_WEBHOOK_PORT) || 3006;';
    const hostLine = "const platformWebhookHost = process.env.ETHOS_SERVE_HOST ?? '127.0.0.1';";
    // Asserted against BOTH files with the same literal: a deployment that
    // moves the port by env var must move it for both entry points at once.
    for (const src of [boot, gateway]) {
      expect(src).toContain(portLine);
      expect(src).toContain(hostLine);
    }
  });

  it('reserves the bound port against the web bind ladder', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    // boot.ts is the only entry point that walks a fallback ladder for the web
    // bind, so it is the only one that can collide with its own listener.
    // Reserved unconditionally since Phase C — see the matching assertion in
    // `boot-profile-command.test.ts` for why.
    expect(src).toContain('platformWebhookPort]);');
    const reservedAt = src.indexOf('const reservedPorts = new Set<number>(');
    const ladderAt = src.indexOf('listenWithFallback(');
    expect(reservedAt).toBeGreaterThan(-1);
    expect(ladderAt).toBeGreaterThan(reservedAt);
  });

  it('closes the server on shutdown, under its own guard', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    // `guard()` per teardown, so one failing close cannot strand the rest —
    // boot.ts's shutdown idiom, not gateway.ts's bare sequence.
    expect(src).toMatch(
      /await guard\('platform-webhook-server', \(\) => \{\s*\n\s*platformWebhookServer\?\.close\(\);\s*\n\s*\}\);/,
    );
  });
});

// ---------------------------------------------------------------------------
// §5 — durable inbound dedup wiring. The store's own semantics (TTL, restart
// survival) are covered by `extensions/inbound-dedup` and
// `extensions/gateway/src/__tests__/inbound-dedup-durable.test.ts`; what is
// asserted here is only that something actually constructs it and hands it to
// the Gateway, which is the gap this lane closed.
// ---------------------------------------------------------------------------

describe('§5 durable inbound dedup wiring (source)', () => {
  for (const file of ['apps/ethos/src/commands/gateway.ts', 'apps/ethos/src/commands/boot.ts']) {
    it(`${file} constructs the store, passes it to buildGateway, and closes it`, async () => {
      const src = await read(file);
      expect(src).toContain("import { SQLiteInboundDedupStore } from '@ethosagent/inbound-dedup';");
      expect(src).toMatch(/new SQLiteInboundDedupStore\(join\(.*'inbound-dedup\.db'\)\)/);
      expect(src).toMatch(/deliveryLedger,\n\s*inboundDedup,/);
      expect(src).toContain('inboundDedup.close();');
    });
  }

  it('is a required BuildGatewayOptions field, so no caller can forget it', async () => {
    const src = await read('apps/ethos/src/commands/gateway.ts');
    expect(src).toContain("inboundDedup: GatewayConfig['inboundDedup'];");
  });

  it('the gateway package declares the workspace edge it imports the type from', async () => {
    const pkg = JSON.parse(await read('extensions/gateway/package.json')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['@ethosagent/inbound-dedup']).toBe('workspace:*');
  });
});
