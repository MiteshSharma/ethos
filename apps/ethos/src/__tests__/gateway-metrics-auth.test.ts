// P2-counters (D16/D17) — the gateway health server's `/metrics` must stay
// gated by `metrics:read` even when an operator rebinds ETHOS_SERVE_HOST
// off-loopback (see docs/content/using/how-to/monitor-with-grafana.md).
// Mirrors apps/web-api/src/__tests__/routes/metrics.test.ts's coverage of
// the equivalent web-api behavior, at the auth-check-function level since
// booting the full gateway is impractical in a unit test.

import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGatewayMetricsAuthCheck } from '../commands/gateway';
import { createHealthServer } from '../health-server';

describe('createGatewayMetricsAuthCheck', () => {
  let apiKeys: SqliteApiKeyStore;

  beforeEach(() => {
    apiKeys = new SqliteApiKeyStore(':memory:');
  });

  afterEach(() => {
    apiKeys.close();
  });

  it('rejects a missing Authorization header', async () => {
    const check = createGatewayMetricsAuthCheck(apiKeys);
    expect(await check(undefined)).toBe(false);
  });

  it('rejects a non-Bearer scheme', async () => {
    const check = createGatewayMetricsAuthCheck(apiKeys);
    expect(await check('Basic whatever')).toBe(false);
  });

  it('rejects a secret not in the sk-ethos- format', async () => {
    const check = createGatewayMetricsAuthCheck(apiKeys);
    expect(await check('Bearer sk_live_notethos')).toBe(false);
  });

  it('rejects an unknown key', async () => {
    const check = createGatewayMetricsAuthCheck(apiKeys);
    expect(await check('Bearer sk-ethos-doesnotexist')).toBe(false);
  });

  it('rejects a key missing the metrics:read scope', async () => {
    const { secret } = await apiKeys.create({ name: 'chat-only', scopes: ['chat'] });
    const check = createGatewayMetricsAuthCheck(apiKeys);
    expect(await check(`Bearer ${secret}`)).toBe(false);
  });

  it('accepts a key with the metrics:read scope', async () => {
    const { secret } = await apiKeys.create({ name: 'prometheus', scopes: ['metrics:read'] });
    const check = createGatewayMetricsAuthCheck(apiKeys);
    expect(await check(`Bearer ${secret}`)).toBe(true);
  });

  it('gates a real /metrics request end-to-end through createHealthServer', async () => {
    const { secret } = await apiKeys.create({ name: 'prometheus', scopes: ['metrics:read'] });
    const check = createGatewayMetricsAuthCheck(apiKeys);
    const server = createHealthServer(
      0,
      '127.0.0.1',
      () => ({ status: 'ok', uptime: 0 }),
      async () => 'ethos_tool_calls_total{tool="bash",outcome="ok"} 1\n',
      check,
    );
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('unexpected address');

      const unauthorized = await fetch(`http://127.0.0.1:${addr.port}/metrics`);
      expect(unauthorized.status).toBe(401);

      const authorized = await fetch(`http://127.0.0.1:${addr.port}/metrics`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      expect(authorized.status).toBe(200);
      expect(await authorized.text()).toContain('ethos_tool_calls_total');
    } finally {
      server.close();
    }
  });
});
