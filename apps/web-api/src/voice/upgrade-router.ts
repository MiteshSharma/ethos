import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

// ONE `upgrade` listener per HTTP server, dispatching by path.
//
// Node's `upgrade` event has no routing: every listener sees every upgrade and
// each one decides for itself. That is fine while there is a single WebSocket
// lane, and wrong the moment there are two — the browser voice lane's handler
// used to refuse any path but `/voice/ws` with a 404 and destroy the socket,
// so a second listener registered for `/satellite/ws` would be handed a socket
// that was already gone. Ordering luck is not a fix: the bug reappears the
// first time someone attaches the lanes in the other order.
//
// So path dispatch lives here, in front of both. Handlers register a path; the
// single listener resolves it and refuses anything unmatched with one 404 —
// which also means an upgrade nobody claims is CLOSED rather than left dangling
// on a socket no code owns.
//
// The router is keyed by server object (a `WeakMap`, so a closed server's
// router is collectable), not by module-global mutable state: two servers in
// one process — the common shape in tests — get two independent routing tables,
// and a lane attached to one is not reachable through the other.

/**
 * What `attach` needs: anything that emits `upgrade`. Typed structurally
 * because `@hono/node-server` returns an http/http2 union, not a plain
 * `http.Server`.
 */
export interface UpgradableServer {
  on(
    event: 'upgrade',
    listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): unknown;
}

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

class UpgradeRouter {
  private readonly routes = new Map<string, UpgradeHandler>();

  constructor(server: UpgradableServer) {
    server.on('upgrade', (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      const handler = this.routes.get(path);
      if (!handler) {
        refuseUpgrade(socket, 404, 'Not Found');
        return;
      }
      handler(req, socket, head);
    });
  }

  register(path: string, handler: UpgradeHandler): void {
    this.routes.set(path, handler);
  }

  /** Only drops the route when `handler` is still the one registered, so a
   *  lane closing after a replacement attached does not unmount the live one. */
  unregister(path: string, handler: UpgradeHandler): void {
    if (this.routes.get(path) === handler) this.routes.delete(path);
  }
}

const routersByServer = new WeakMap<UpgradableServer, UpgradeRouter>();

/**
 * Serve `path` on this server's upgrade listener. Returns the deregistration
 * closure; after it runs, `path` 404s like any other unclaimed path.
 */
export function registerUpgradeRoute(
  server: UpgradableServer,
  path: string,
  handler: UpgradeHandler,
): () => void {
  let router = routersByServer.get(server);
  if (!router) {
    router = new UpgradeRouter(server);
    routersByServer.set(server, router);
  }
  const bound = router;
  bound.register(path, handler);
  return () => bound.unregister(path, handler);
}

/** Refuse an upgrade with a bare HTTP status line and close the socket. */
export function refuseUpgrade(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\n\r\n`);
  socket.destroy();
}
