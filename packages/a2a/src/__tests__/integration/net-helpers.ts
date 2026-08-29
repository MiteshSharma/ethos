// Raw `node:net` fixtures for T1.8's timeout + backoff integration tests.
// These are deliberately below the HTTP layer: a socket that accepts and then
// says nothing is a much closer model of "a peer that hung" than a stubbed
// `fetch` that waits on an `AbortSignal` — the abort has to actually tear down
// a live TCP connection, not just resolve a mocked promise.

import { createConnection, createServer, type Server, type Socket } from 'node:net';

export interface HangingListener {
  url: string;
  close(): Promise<void>;
}

/** Accepts every TCP connection and never writes or closes it — a peer that took the call and went silent. */
export async function startHangingListener(): Promise<HangingListener> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // Intentionally: no data, no end, no destroy.
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(addr && typeof addr === 'object' ? addr.port : 0);
    });
  });
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

export interface FailNTimesThenProxy {
  url: string;
  attempts(): number;
  close(): Promise<void>;
}

/**
 * A raw TCP gate in front of a real upstream server: the first `failCount`
 * connections are reset immediately (a real transport failure — `fetch` sees
 * an actual socket error, not a thrown JS error); every connection after that
 * is piped byte-for-byte to `upstreamPort` on loopback, so the eventual
 * "success" attempt is served by the real thing, not a canned response.
 */
export async function startFailNTimesThenProxy(
  upstreamPort: number,
  failCount: number,
): Promise<FailNTimesThenProxy> {
  let attempts = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((clientSocket) => {
    attempts += 1;
    sockets.add(clientSocket);
    clientSocket.on('close', () => sockets.delete(clientSocket));

    if (attempts <= failCount) {
      clientSocket.destroy();
      return;
    }

    const upstream = createConnection({ port: upstreamPort, host: '127.0.0.1' }, () => {
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(addr && typeof addr === 'object' ? addr.port : 0);
    });
  });
  return {
    url: `http://127.0.0.1:${port}/`,
    attempts: () => attempts,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
