import { type Contract, contract } from '@ethosagent/web-contracts';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';

// Typed oRPC client. The shape is locked by `@ethosagent/web-contracts`,
// which both the server (`extensions/web-api`) and this file import — if
// the contract changes, both ends fail to compile.
//
// Auth piggybacks on the same cookie the server set during the
// `/auth/exchange` redirect; `credentials: 'include'` makes every fetch
// send it. CSRF is the server's `Origin` check (csrf middleware), no
// additional client work needed here.
//
// `apiBase` defaults to same-origin so the production `ethos serve`
// deployment (Vite static + API on the same Hono app) just works. Vite's
// dev server proxies `/rpc` to :3000 — see `vite.config.ts` — so
// same-origin holds in dev too.

// `RPCLink` calls `new URL(url)` internally, which requires an absolute URL.
// In dev (Vite), same-origin = `http://localhost:5173`; the proxy forwards
// `/rpc` → `:3000`. In prod (single-port), same-origin = `:3000` directly.
const apiBase =
  import.meta.env.VITE_API_URL ?? (typeof window !== 'undefined' ? window.location.origin : '');

const link = new RPCLink({
  url: `${apiBase}/rpc`,
  fetch: (input, init) =>
    fetch(input, {
      ...init,
      credentials: 'include',
    }),
});

export const rpc: ContractRouterClient<Contract> = createORPCClient(link);

// Keep a runtime reference so the contract module isn't tree-shaken when
// it's only used for types. Mirrors the praxis pattern.
void contract;
