import { isEthosError } from '@ethosagent/types';
import { ORPCError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { Hono } from 'hono';
import { statusFor } from '../middleware/error-envelope';
import { apiRouter } from '../rpc/router';
import type { ServiceContainer } from './index';

// Mounts the oRPC handler at `/*` (relative to wherever this sub-app is
// attached — `createWebApi` mounts it under `/rpc`). The handler lifts the
// service container into the procedure context, so each procedure body sees
// a fully-typed `context.sessions`, etc.
//
// Interceptor: services raise `EthosError` with structured codes. oRPC, on
// its own, catches anything that isn't `ORPCError` and renders 500 with a
// generic message — the structured code never reaches the wire. The
// interceptor translates `EthosError → ORPCError`, mirroring the
// `code/status/message` mapping the `error-envelope` middleware applies to
// non-RPC routes.

export interface RpcRoutesOptions {
  services: ServiceContainer;
}

export function rpcRoutes(opts: RpcRoutesOptions) {
  const handler = new RPCHandler(apiRouter, {
    interceptors: [
      async (options) => {
        try {
          return await options.next();
        } catch (err) {
          if (isEthosError(err)) {
            throw new ORPCError(err.code, {
              status: statusFor(err.code),
              message: err.cause,
              data: { action: err.action },
              cause: err,
            });
          }
          throw err;
        }
      },
    ],
  });
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
