import { EthosError } from '@ethosagent/types';
import { serve as honoServe } from '@hono/node-server';

// Port-binding helper. Tries `basePort`, falls forward on EADDRINUSE up to
// `attempts` times. Pulled out of `serve.ts` so a focused unit test can
// import it without transitively loading the ACP server / mesh wiring.
//
// The minimal app shape (`{ fetch }`) is what `@hono/node-server` requires —
// it accepts any object with a `fetch` method, not just a `Hono` instance.

export interface ListenResult {
  server: ReturnType<typeof honoServe>;
  port: number;
}

export type FetchApp = { fetch: (req: Request) => Response | Promise<Response> };

export async function listenWithFallback(
  app: FetchApp,
  basePort: number,
  attempts: number,
  hostname = '127.0.0.1',
): Promise<ListenResult> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const port = basePort + i;
    try {
      const result = await tryListen(app, port, hostname);
      if (i > 0) {
        console.warn(
          `⚠ Port ${basePort} was taken — bound ${port} instead. If you use the Vite dev proxy ` +
            `(make web-dev), it still points at ${basePort} and will talk to whatever owns that port.`,
        );
      }
      return result;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      lastErr = err;
    }
  }
  throw new EthosError({
    code: 'INTERNAL',
    cause: `No free port in range ${basePort}-${basePort + attempts - 1}`,
    action:
      'Pass --web-port=<n> to pick a different starting port, or stop whatever is using these.',
    details: { lastErr: lastErr instanceof Error ? lastErr.message : String(lastErr) },
  });
}

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  yellow: '\x1b[33m',
};

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

// Startup banner for a non-loopback web bind. Returns null for loopback —
// the caller prints nothing extra in the normal local case.
//
// Two things the operator needs at once: the surfaces that just became
// network-reachable, and the fact that `secureCookie` flips on for a
// non-loopback bind (serve.ts), which breaks web-UI login over plain http.
// Without the second line the symptom reads as a broken login, not a
// deliberate posture.
export function formatNonLoopbackWarning(host: string, port: number): string | null {
  if (isLoopbackHost(host)) return null;

  const body = [
    'SECURITY: the web server is bound to a NON-LOOPBACK address.',
    '',
    `  bind: ${host}:${port}`,
    '',
    'These surfaces are now reachable from other hosts on the network:',
    '  - /v1/*   OpenAI-compatible API',
    '  - /rpc/*  Mission Control RPC',
    '  - the web UI',
    'Any personality whose toolset includes `bash` therefore exposes command',
    'execution on this host to whoever can reach this port.',
    '',
    'The auth cookie is marked Secure on a non-loopback bind, so the web UI',
    'WILL NOT LOG IN over plain http. Front this port with a TLS-terminating',
    'reverse proxy and set `webBaseUrl` to its https:// URL rather than',
    'exposing the port directly.',
    '',
    'How-to: docs/content/building/how-to/deploy-mission-control-remote.md',
  ];

  // Width is derived from the content so a long hostname can't overflow the
  // box. Every line is plain ASCII, so `.length` is the printed width.
  const inner = body.reduce((max, line) => Math.max(max, line.length), 0) + 2;
  const paint = (line: string, weight = '') => `${c.yellow}${weight}${line}${c.reset}`;
  return [
    paint(`┌${'─'.repeat(inner)}┐`, c.bold),
    ...body.map((line) => paint(`│ ${line.padEnd(inner - 2)} │`)),
    paint(`└${'─'.repeat(inner)}┘`, c.bold),
  ].join('\n');
}

function tryListen(app: FetchApp, port: number, hostname: string): Promise<ListenResult> {
  return new Promise((resolve, reject) => {
    const server = honoServe({ fetch: app.fetch, port, hostname }, () => {
      resolve({ server, port });
    });
    // The Node server underlying @hono/node-server emits 'error' for bind
    // failures. Catch once; resolve has either fired by then or the error
    // beat it.
    server.once('error', (err) => reject(err));
  });
}
