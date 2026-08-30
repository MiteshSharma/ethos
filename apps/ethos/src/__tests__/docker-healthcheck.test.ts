// W1.2 — mode-aware container healthcheck matrix (3 modes × healthy/stale).
//
// The script under test is docker/docker-healthcheck.sh (baked into the
// image). Each case spins a tiny HTTP server that mimics the real /healthz
// payloads (web-api routes/index.ts for ui/all; the gateway health server
// for gateway mode), shells the script out against it, and asserts the exit
// code. Liveness semantics under test: only definitive local failure (no
// response; stale/dead gateway child in `all` mode) is unhealthy — upstream
// degradation (503 "degraded") stays healthy.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', '..', '..', 'docker', 'docker-healthcheck.sh');
const ENTRYPOINT = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'docker',
  'docker-entrypoint.sh',
);

let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  servers = [];
});

function serveHealthz(status: number, body: unknown): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function runScript(env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    execFile('sh', [SCRIPT], { env: { ...process.env, ...env } }, (err) => {
      resolve(err && typeof err.code === 'number' ? err.code : err ? 1 : 0);
    });
  });
}

// Payload shapes mirrored from the real endpoints.
const webHealthy = {
  status: 'ok',
  uptime: 12,
  gateway: { status: 'ok', adapters: [{ name: 'telegram:default', ok: true }] },
};
const webDegradedGatewayOk = {
  // Fresh heartbeat but zero adapters (fresh single-service boot) — the
  // endpoint returns 503 "degraded", yet the container must stay healthy.
  status: 'degraded',
  uptime: 12,
  gateway: { status: 'ok', adapters: [], lastHeartbeatAgeSec: 2 },
};
const webStale = {
  status: 'degraded',
  uptime: 12,
  gateway: { status: 'stale', adapters: [{ name: 'telegram:default', ok: true }] },
};
const webGatewayDown = {
  status: 'degraded',
  uptime: 12,
  gateway: { status: 'down', adapters: [], lastHeartbeatAgeSec: null },
};
const gatewayHealthy = {
  status: 'ok',
  uptime: 12,
  adapters: [{ name: 'telegram:default', ok: true }],
};
const gatewayDegraded = {
  // Adapter can't reach Telegram — upstream outage, container stays healthy.
  status: 'degraded',
  uptime: 12,
  adapters: [{ name: 'telegram:default', ok: false }],
};

describe('docker-healthcheck.sh mode matrix', () => {
  it('ui mode: healthy endpoint → exit 0', async () => {
    const port = await serveHealthz(200, webHealthy);
    expect(await runScript({ ETHOS_MODE: 'ui', ETHOS_HEALTHCHECK_WEB_PORT: String(port) })).toBe(0);
  });

  it('ui mode: degraded (gateway down elsewhere) → still exit 0 (not this container)', async () => {
    const port = await serveHealthz(503, webGatewayDown);
    expect(await runScript({ ETHOS_MODE: 'ui', ETHOS_HEALTHCHECK_WEB_PORT: String(port) })).toBe(0);
  });

  it('ui mode: no server listening → exit 1', async () => {
    expect(await runScript({ ETHOS_MODE: 'ui', ETHOS_HEALTHCHECK_WEB_PORT: '1' })).toBe(1);
  });

  it('all mode: fresh heartbeat, adapters live → exit 0', async () => {
    const port = await serveHealthz(200, webHealthy);
    expect(await runScript({ ETHOS_MODE: 'all', ETHOS_HEALTHCHECK_WEB_PORT: String(port) })).toBe(
      0,
    );
  });

  it('all mode: fresh heartbeat, zero adapters (degraded 503) → exit 0', async () => {
    const port = await serveHealthz(503, webDegradedGatewayOk);
    expect(await runScript({ ETHOS_MODE: 'all', ETHOS_HEALTHCHECK_WEB_PORT: String(port) })).toBe(
      0,
    );
  });

  it('all mode: stale heartbeat (gateway child wedged) → exit 1', async () => {
    const port = await serveHealthz(503, webStale);
    expect(await runScript({ ETHOS_MODE: 'all', ETHOS_HEALTHCHECK_WEB_PORT: String(port) })).toBe(
      1,
    );
  });

  it('all mode: heartbeat missing (gateway child dead) → exit 1', async () => {
    const port = await serveHealthz(503, webGatewayDown);
    expect(await runScript({ ETHOS_MODE: 'all', ETHOS_HEALTHCHECK_WEB_PORT: String(port) })).toBe(
      1,
    );
  });

  it('all mode: no server listening → exit 1', async () => {
    expect(await runScript({ ETHOS_MODE: 'all', ETHOS_HEALTHCHECK_WEB_PORT: '1' })).toBe(1);
  });

  it('gateway mode: healthy → exit 0', async () => {
    const port = await serveHealthz(200, gatewayHealthy);
    expect(
      await runScript({ ETHOS_MODE: 'gateway', ETHOS_GATEWAY_HEALTH_PORT: String(port) }),
    ).toBe(0);
  });

  it('gateway mode: degraded adapters (upstream outage) → still exit 0', async () => {
    const port = await serveHealthz(503, gatewayDegraded);
    expect(
      await runScript({ ETHOS_MODE: 'gateway', ETHOS_GATEWAY_HEALTH_PORT: String(port) }),
    ).toBe(0);
  });

  it('gateway mode: process dead (no response) → exit 1', async () => {
    expect(await runScript({ ETHOS_MODE: 'gateway', ETHOS_GATEWAY_HEALTH_PORT: '1' })).toBe(1);
  });

  it('boot mode: healthy → exit 0', async () => {
    const port = await serveHealthz(200, gatewayHealthy);
    expect(await runScript({ ETHOS_MODE: 'boot', ETHOS_GATEWAY_HEALTH_PORT: String(port) })).toBe(
      0,
    );
  });

  it('boot mode: degraded adapters (upstream outage) → still exit 0', async () => {
    const port = await serveHealthz(503, gatewayDegraded);
    expect(await runScript({ ETHOS_MODE: 'boot', ETHOS_GATEWAY_HEALTH_PORT: String(port) })).toBe(
      0,
    );
  });

  it('boot mode: process dead (no response) → exit 1', async () => {
    expect(await runScript({ ETHOS_MODE: 'boot', ETHOS_GATEWAY_HEALTH_PORT: '1' })).toBe(1);
  });

  it('unknown mode → exit 1', async () => {
    expect(await runScript({ ETHOS_MODE: 'bogus' })).toBe(1);
  });
});

describe('docker-entrypoint.sh SIGTERM contract', () => {
  it('every mode execs the CLI so signals reach PID 1 directly', () => {
    // Clean SIGTERM stop depends on `exec` — without it, sh stays PID 1 and
    // swallows the signal, and `docker stop` escalates to SIGKILL. The full
    // container-level test runs in CI (docker-publish.yml smoke gate,
    // "SIGTERM clean stop" step).
    const entrypoint = readFileSync(ENTRYPOINT, 'utf-8');
    expect(entrypoint).toMatch(/all\)\s+exec ethos run-all/);
    expect(entrypoint).toMatch(/gateway\)\s+exec ethos gateway start/);
    expect(entrypoint).toMatch(/ui\)\s+exec ethos serve/);
  });
});
