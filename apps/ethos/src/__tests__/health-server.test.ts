import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createHealthServer } from '../health-server';

describe('createHealthServer', () => {
  let server: Server | null = null;

  afterEach(() => {
    if (server) {
      server.close();
      server = null;
    }
  });

  it('returns 200 with ok status', async () => {
    server = createHealthServer(0, '127.0.0.1', () => ({
      status: 'ok',
      uptime: 42,
    }));
    const s = server;
    if (!s) throw new Error('no server');
    await new Promise<void>((resolve) => s.once('listening', resolve));
    const addr = s.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected address');
    const res = await fetch(`http://127.0.0.1:${addr.port}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.uptime).toBe(42);
  });

  it('returns 503 with degraded status', async () => {
    server = createHealthServer(0, '127.0.0.1', () => ({
      status: 'degraded',
      uptime: 0,
    }));
    const s = server;
    if (!s) throw new Error('no server');
    await new Promise<void>((resolve) => s.once('listening', resolve));
    const addr = s.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected address');
    const res = await fetch(`http://127.0.0.1:${addr.port}/healthz`);
    expect(res.status).toBe(503);
  });

  it('returns 404 for unknown paths', async () => {
    server = createHealthServer(0, '127.0.0.1', () => ({
      status: 'ok',
      uptime: 0,
    }));
    const s = server;
    if (!s) throw new Error('no server');
    await new Promise<void>((resolve) => s.once('listening', resolve));
    const addr = s.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected address');
    const res = await fetch(`http://127.0.0.1:${addr.port}/other`);
    expect(res.status).toBe(404);
  });

  // P2-counters (D2/D16) — `/metrics` on the gateway health server.
  describe('/metrics', () => {
    it('404s when no getMetricsText is supplied (unchanged pre-P2 behavior)', async () => {
      server = createHealthServer(0, '127.0.0.1', () => ({ status: 'ok', uptime: 0 }));
      const s = server;
      if (!s) throw new Error('no server');
      await new Promise<void>((resolve) => s.once('listening', resolve));
      const addr = s.address();
      if (!addr || typeof addr === 'string') throw new Error('unexpected address');
      const res = await fetch(`http://127.0.0.1:${addr.port}/metrics`);
      expect(res.status).toBe(404);
    });

    it('serves OpenMetrics text with no auth check when none is wired', async () => {
      server = createHealthServer(
        0,
        '127.0.0.1',
        () => ({ status: 'ok', uptime: 0 }),
        async () => 'ethos_tool_calls_total{tool="bash",outcome="ok"} 1\n',
      );
      const s = server;
      if (!s) throw new Error('no server');
      await new Promise<void>((resolve) => s.once('listening', resolve));
      const addr = s.address();
      if (!addr || typeof addr === 'string') throw new Error('unexpected address');
      const res = await fetch(`http://127.0.0.1:${addr.port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4');
      const body = await res.text();
      expect(body).toContain('ethos_tool_calls_total');
    });

    it('401s an unauthorized scrape when an auth check is wired', async () => {
      server = createHealthServer(
        0,
        '127.0.0.1',
        () => ({ status: 'ok', uptime: 0 }),
        async () => 'ok\n',
        (auth) => auth === 'Bearer sk-ethos-good',
      );
      const s = server;
      if (!s) throw new Error('no server');
      await new Promise<void>((resolve) => s.once('listening', resolve));
      const addr = s.address();
      if (!addr || typeof addr === 'string') throw new Error('unexpected address');

      const unauthorized = await fetch(`http://127.0.0.1:${addr.port}/metrics`);
      expect(unauthorized.status).toBe(401);

      const authorized = await fetch(`http://127.0.0.1:${addr.port}/metrics`, {
        headers: { authorization: 'Bearer sk-ethos-good' },
      });
      expect(authorized.status).toBe(200);
    });
  });
});
