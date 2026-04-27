import { RPCHandler } from '@orpc/server/fetch';
import { Hono } from 'hono';
import { apiRouter } from '../rpc/router';
import type { ServiceContainer } from './index';

// Mounts the oRPC handler at `/*` (relative to wherever this sub-app is
// attached — `createWebApi` mounts it under `/rpc`). The handler lifts the
// service container into the procedure context, so each procedure body sees
// a fully-typed `context.sessions`, etc.

export interface RpcRoutesOptions {
  services: ServiceContainer;
}

export function rpcRoutes(opts: RpcRoutesOptions) {
  const handler = new RPCHandler(apiRouter);
  const app = new Hono();

  app.all('/*', async (c) => {
    const { matched, response } = await handler.handle(c.req.raw, {
      prefix: '/rpc',
      context: opts.services,
    });
    if (matched && response) return response;
    return c.text('Not Found', 404);
  });

  return app;
}
