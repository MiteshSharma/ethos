// plan/phases/gateway-live-reload.md Phase D — per-server port rebind (§0 row
// 9, §5.6).
//
// SCOPE, CONFIRMED FROM SOURCE. §0 row 9 lists five listeners, but only the
// web bind is a CONFIG key: `runBoot` resolves `acpPort` from the `--port` CLI
// flag and health / webhook / platform-webhook from `ETHOS_GATEWAY_HEALTH_PORT`
// / `ETHOS_WEBHOOK_PORT` / `ETHOS_PLATFORM_WEBHOOK_PORT`. A config differ
// cannot observe an env var, so the "no config key for the other four" claim is
// asserted against boot.ts's own resolution block below rather than assumed.
//
// `commands/boot.ts` is not runtime-importable from vitest (it reaches
// `commands/serve.ts` → `@ethosagent/acp-server`, an app with no alias), which
// is why the decision (`planWebRebind`) and the mechanism (`rebindWebServer`)
// both live in `config-reload.ts` and are executed FOR REAL here — over real
// HTTP, against real sockets — exactly as Phases A and C did it.

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { type EthosConfig, ethosDir, loadConfigStrict } from '@ethosagent/config';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { Logger } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listenWithFallback } from '../commands/serve-listen';
import {
  planWebRebind,
  rebindWebServer,
  resolveWebBind,
  type WebBindTarget,
} from '../config-reload';

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

function recordingLogger(): Logger & { warnings: string[]; errors: string[]; infos: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const infos: string[] = [];
  const logger: Logger & { warnings: string[]; errors: string[]; infos: string[] } = {
    warnings,
    errors,
    infos,
    debug: () => {},
    info: (m: string) => {
      infos.push(m);
    },
    warn: (m: string) => {
      warnings.push(m);
    },
    error: (m: string) => {
      errors.push(m);
    },
    child: () => logger,
  };
  return logger;
}

/** A port nothing is listening on right now. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const APP = { fetch: () => new Response('served') };

/** The caller's ladder, at depth 1 so an occupied target FAILS instead of
 *  quietly landing one port over — that is the case §5.6 wants exercised. */
const listenOnce = (bind: WebBindTarget) => listenWithFallback(APP, bind.port, 1, bind.host);

const opened: Array<{ close(cb?: () => void): unknown }> = [];
afterEach(async () => {
  await Promise.all(
    opened.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

describe('planWebRebind — what actually moves the live bind', () => {
  const LIVE: WebBindTarget = { host: '127.0.0.1', port: 3000 };

  it('rebinds when config.yaml moves the port', async () => {
    const cfg = await load([...BASE, 'web.port: 4100']);
    expect(planWebRebind(LIVE, cfg, [], {})).toEqual({
      action: 'rebind',
      target: { host: '127.0.0.1', port: 4100 },
    });
  });

  it('rebinds when config.yaml moves the host', async () => {
    const cfg = await load([...BASE, 'web.host: 0.0.0.0']);
    expect(planWebRebind(LIVE, cfg, [], {})).toEqual({
      action: 'rebind',
      target: { host: '0.0.0.0', port: 3000 },
    });
  });

  it('skips when the configured address is already the live one', async () => {
    const cfg = await load([...BASE, 'web.port: 3000']);
    expect(planWebRebind(LIVE, cfg, [], {})).toEqual({
      action: 'skip',
      reason: 'the configured address is already the live one',
    });
  });

  it('skips, naming the precedence, when --web-port pins the bind', async () => {
    const cfg = await load([...BASE, 'web.port: 4100']);
    const decision = planWebRebind(LIVE, cfg, ['--web-port', '3000'], {});
    expect(decision.action).toBe('skip');
    expect(decision).toMatchObject({
      reason: '--web-port/--web-host or ETHOS_WEB_PORT/ETHOS_WEB_HOST outranks config.yaml',
    });
  });

  it('skips when ETHOS_WEB_PORT pins the bind', async () => {
    const cfg = await load([...BASE, 'web.port: 4100']);
    const decision = planWebRebind(LIVE, cfg, [], { ETHOS_WEB_PORT: '3000' });
    expect(decision.action).toBe('skip');
  });

  it('resolves with the same precedence cold boot uses', async () => {
    const cfg = await load([...BASE, 'web.port: 4100', 'web.host: 0.0.0.0']);
    expect(resolveWebBind(cfg, [], {})).toEqual({ host: '0.0.0.0', port: 4100 });
    expect(resolveWebBind(cfg, ['--web-port=5100'], {})).toEqual({
      host: '0.0.0.0',
      port: 5100,
    });
  });
});

describe('rebindWebServer — one server closes and re-listens', () => {
  it('serves the new address, stops serving the old one, and touches nothing else', async () => {
    const from = await freePort();
    const to = await freePort();
    expect(to).not.toBe(from);
    const logger = recordingLogger();

    // §5.6's assertion, made directly: the subsystems a rebind must not
    // disturb, as spies that would record a call if one happened.
    const createAgentLoop = vi.fn();
    const meshRegister = vi.fn();
    const sessionStoreClose = vi.fn();
    const gatewayShutdown = vi.fn();

    const first = await listenOnce({ host: '127.0.0.1', port: from });
    opened.push(first.server);
    expect(await (await fetch(`http://127.0.0.1:${from}/`)).text()).toBe('served');

    const attached: unknown[] = [];
    const outcome = await rebindWebServer({
      server: first.server,
      current: { host: '127.0.0.1', port: from },
      target: { host: '127.0.0.1', port: to },
      listen: listenOnce,
      onListening: (server) => attached.push(server),
      logger,
    });
    opened.push(outcome.server);

    expect(outcome.port).toBe(to);
    expect(outcome.requested).toEqual({ host: '127.0.0.1', port: to });
    expect(outcome.fellBack).toBe(false);
    // The WebSocket upgrade routes follow the listener, once, to the new one.
    expect(attached).toEqual([outcome.server]);
    expect(logger.infos).toEqual([`[config-reload] web server rebound to 127.0.0.1:${to}`]);

    // The new address answers...
    expect(await (await fetch(`http://127.0.0.1:${to}/`)).text()).toBe('served');
    // ...and the old one is gone, not merely idle.
    await expect(fetch(`http://127.0.0.1:${from}/`)).rejects.toThrow();

    // Nothing else moved. `rebindWebServer` takes no such dependency, which is
    // what makes this hold structurally rather than by luck.
    expect(createAgentLoop).not.toHaveBeenCalled();
    expect(meshRegister).not.toHaveBeenCalled();
    expect(sessionStoreClose).not.toHaveBeenCalled();
    expect(gatewayShutdown).not.toHaveBeenCalled();
  });

  it('falls back to the previous address, warning by name, when the new port is taken', async () => {
    const from = await freePort();
    const to = await freePort();
    const logger = recordingLogger();

    // Somebody else already owns the port the operator just asked for.
    const blocker = createServer((_req, res) => res.end('blocker'));
    await new Promise<void>((resolve) => blocker.listen(to, '127.0.0.1', () => resolve()));
    opened.push(blocker);

    const first = await listenOnce({ host: '127.0.0.1', port: from });
    const attached: unknown[] = [];
    const outcome = await rebindWebServer({
      server: first.server,
      current: { host: '127.0.0.1', port: from },
      target: { host: '127.0.0.1', port: to },
      listen: listenOnce,
      onListening: (server) => attached.push(server),
      logger,
    });
    opened.push(outcome.server);

    expect(outcome.fellBack).toBe(true);
    expect(outcome.port).toBe(from);
    expect(outcome.requested).toEqual({ host: '127.0.0.1', port: from });
    expect(attached).toEqual([outcome.server]);
    expect(logger.warnings).toEqual([
      `[config-reload] web server could not bind 127.0.0.1:${to} — reverting to 127.0.0.1:${from}`,
    ]);
    expect(logger.errors).toEqual([]);

    // The operator is NOT left with no web server.
    expect(await (await fetch(`http://127.0.0.1:${from}/`)).text()).toBe('served');
    // And the port they asked for still belongs to whoever already had it.
    expect(await (await fetch(`http://127.0.0.1:${to}/`)).text()).toBe('blocker');
  });

  it('says so, at error level, when even the previous address cannot be reclaimed', async () => {
    const from = await freePort();
    const to = await freePort();
    const logger = recordingLogger();
    const first = await listenOnce({ host: '127.0.0.1', port: from });

    // Every bind fails — the range is exhausted, the host does not resolve.
    const listen = () => Promise.reject(new Error('EADDRINUSE'));
    await expect(
      rebindWebServer({
        server: first.server,
        current: { host: '127.0.0.1', port: from },
        target: { host: '127.0.0.1', port: to },
        listen,
        onListening: () => {},
        logger,
      }),
    ).rejects.toThrow('EADDRINUSE');
    expect(logger.errors).toEqual([
      `[config-reload] web server is NOT listening — 127.0.0.1:${to} could not be bound and 127.0.0.1:${from} could not be reclaimed`,
    ]);
  });
});

describe('boot.ts wiring (source)', () => {
  it('confirms only the web bind is a config key — the other four ports are env/CLI', async () => {
    const src = await readFile(join(ROOT, 'apps/ethos/src/commands/boot.ts'), 'utf8');
    expect(src).toContain("const acpPort = parsePort(parseFlagValue(args, ['--port'])");
    expect(src).toContain('process.env.ETHOS_GATEWAY_HEALTH_PORT');
    expect(src).toContain('process.env.ETHOS_WEBHOOK_PORT');
    expect(src).toContain('process.env.ETHOS_PLATFORM_WEBHOOK_PORT');
    // The web bind is the one resolved from `cfg`, which is what makes it the
    // only listener a config diff can ever observe moving.
    expect(src).toContain('const webPort = resolveWebPort(args, process.env, cfg)');
    expect(src).toContain('const webHost = resolveWebHost(args, process.env, cfg)');
  });

  it('reconciles the web bind without reaching for any other subsystem', async () => {
    const src = await readFile(join(ROOT, 'apps/ethos/src/commands/boot.ts'), 'utf8');
    const start = src.indexOf('const applyWebBindDiff');
    const end = src.indexOf('const configFilePath', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).toContain('planWebRebind');
    expect(body).toContain('rebindWebServer');
    for (const forbidden of [
      'createAgentLoop',
      'mesh.register',
      'sessionStore',
      'jobStore',
      'gateway.',
      'buildGatewayAdapters',
    ]) {
      expect(body).not.toContain(forbidden);
    }
    // The rebind runs the SAME ladder cold boot did, reservations included.
    expect(src).toContain('const listenWeb = (bind: WebBindTarget) =>');
    expect(src).toContain('listen: listenWeb,');
    // Shutdown closes whatever is CURRENTLY listening, not the first listener.
    expect(src).toContain('webServer.close(() => resolve())');
  });
});
