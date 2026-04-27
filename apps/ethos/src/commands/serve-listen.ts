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
): Promise<ListenResult> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const port = basePort + i;
    try {
      const result = await tryListen(app, port);
      if (i > 0) {
        console.log(
          `[web] port ${basePort} busy, fell forward to ${port} (${i} attempt${i === 1 ? '' : 's'})`,
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

function tryListen(app: FetchApp, port: number): Promise<ListenResult> {
  return new Promise((resolve, reject) => {
    const server = honoServe({ fetch: app.fetch, port }, () => {
      resolve({ server, port });
    });
    // The Node server underlying @hono/node-server emits 'error' for bind
    // failures. Catch once; resolve has either fired by then or the error
    // beat it.
    server.once('error', (err) => reject(err));
  });
}
