// ClickListener — a local loopback HTTP listener that resolves when hit at
// its (random-token-gated) URL. This is the receiving end of the
// notification-click bridge: `terminal-notifier -execute` fires a bare OS
// click callback with no session, no turn, no personality context of its
// own (plan/phases/call-capture-extension.md, "Preflight" §6) — this module
// turns that callback into a promise `notification.ts` can await.
//
// The token is random (`crypto.randomBytes`) and required in the request
// path so another local process can't spoof an accept by guessing the URL.
// The port is ephemeral (`listen(0, ...)`) so concurrent offers, and
// concurrent test runs, never collide.

import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export interface ClickListener {
  /** The one-shot URL `-execute`'s `curl` command should hit. */
  readonly url: string;
  /** Resolves the first time `url` is requested. */
  waitForHit(): Promise<void>;
  /** Tears down the HTTP server. Safe to call more than once. */
  close(): void;
}

export function createClickListener(): Promise<ClickListener> {
  return new Promise((resolve, reject) => {
    const token = randomBytes(16).toString('hex');
    let settled = false;
    let resolveHit: () => void = () => {};
    const hit = new Promise<void>((res) => {
      resolveHit = res;
    });

    const server: Server = createServer((req, res) => {
      if (req.url === `/click/${token}`) {
        res.writeHead(204);
        res.end();
        resolveHit();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    server.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    server.listen(0, '127.0.0.1', () => {
      if (settled) return;
      settled = true;
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('click-listener failed to bind to an ephemeral loopback port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/click/${token}`,
        waitForHit: () => hit,
        close: () => {
          server.close();
        },
      });
    });
  });
}
