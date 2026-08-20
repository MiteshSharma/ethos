import { createServer, type Server } from 'node:http';

export interface HealthPayload {
  status: 'ok' | 'degraded';
  uptime: number;
  [key: string]: unknown;
}

export type HealthPayloadFn = () => HealthPayload | Promise<HealthPayload>;

/**
 * P2-counters (D16/D17) — authorizes a `/metrics` scrape on the gateway
 * health server. Receives the raw `Authorization` header value (or
 * `undefined`). Omitted entirely when no api-key store is wired for this
 * process, in which case the loopback-only bind is the sole gate — the same
 * posture `/healthz` on this server already has.
 */
export type MetricsAuthCheck = (
  authorizationHeader: string | undefined,
) => boolean | Promise<boolean>;

export function createHealthServer(
  port: number,
  host: string,
  getPayload: HealthPayloadFn,
  getMetricsText?: () => Promise<string>,
  checkMetricsAuth?: MetricsAuthCheck,
): Server {
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/health')) {
      try {
        const payload = await getPayload();
        const code = payload.status === 'ok' ? 200 : 503;
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      } catch {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'degraded', error: 'health check failed' }));
      }
      return;
    }
    if (req.method === 'GET' && req.url === '/metrics' && getMetricsText) {
      if (checkMetricsAuth && !(await checkMetricsAuth(req.headers.authorization))) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized');
        return;
      }
      try {
        const text = await getMetricsText();
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        res.end(text);
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('metrics render failed');
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(
        `[health] port ${port} in use — health endpoint unavailable. ` +
          `Set ETHOS_GATEWAY_HEALTH_PORT or ETHOS_RUNALL_HEALTH_PORT to change.`,
      );
    }
  });
  server.listen(port, host);
  server.unref();
  return server;
}
