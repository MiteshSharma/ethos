import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { OpenAPIReferencePlugin } from '@orpc/openapi/plugins';
import { Hono } from 'hono';
import { apiRouter } from '../rpc/router';
import type { ServiceContainer } from './index';

// OpenAPI surface — auto-generated from the existing zod-based contract.
// Three things are mounted here under one handler:
//   • `/openapi/`           — Scalar API reference UI (browseable docs)
//   • `/openapi/spec.json`  — raw OpenAPI 3.1 spec for tooling import
//   • `/openapi/<route>`    — REST-shaped endpoints derived from the contract
//                             (procedures without `.route()` annotations land
//                              under their RPC paths as `POST` with body input)
//
// One zod source of truth (`packages/web-contracts`), three transports:
//   • `RPCHandler`     at `/rpc/*`     — what apps/web uses (compact protocol)
//   • `OpenAPIHandler` at `/openapi/*` — what curl / Postman / docs UI use
//   • SSE              at `/sse/*`     — streaming events (Phase 26.3)
//
// All three share the same router and validate inputs through the same Zod
// schemas, so contract drift is impossible.

export interface OpenApiRoutesOptions {
  services: ServiceContainer;
  /** Title shown in the docs UI tab + heading. */
  docsTitle?: string;
}

export function openapiRoutes(opts: OpenApiRoutesOptions) {
  const handler = new OpenAPIHandler(apiRouter, {
    plugins: [
      new OpenAPIReferencePlugin({
        docsPath: '/',
        specPath: '/spec.json',
        docsProvider: 'scalar',
        docsTitle: opts.docsTitle ?? 'Ethos Web API',
        // Generator metadata — surfaces in the docs UI header + spec.json.
        // Lives under `specGenerateOptions` because it's passed through to
        // the OpenAPIGenerator's `generate(...)` call (extends OpenAPI.Document).
        specGenerateOptions: {
          info: {
            title: opts.docsTitle ?? 'Ethos Web API',
            version: '0.1.0',
            description:
              'Auto-generated from the Zod-based oRPC contract in `@ethosagent/web-contracts`. ' +
              'Every procedure validates input through the same Zod schema the typed client uses.',
          },
        },
      }),
    ],
  });

  const app = new Hono();
  app.all('/*', async (c) => {
    const { matched, response } = await handler.handle(c.req.raw, {
      prefix: '/openapi',
      context: opts.services,
    });
    if (matched && response) return response;
    return c.text('Not Found', 404);
  });
  return app;
}
