import { os } from './context';

// Thin RPC shell for the MCP install-flow namespace.
//
// `_mcpPendingState` and `_mcpRequestOrigin` are non-enumerable
// properties set by the Hono layer in routes/rpc.ts:
//
//   - `_mcpPendingState` carries the `ethos_mcp_pending` cookie value
//     into the service so complete/status can validate CSRF binding.
//   - `_mcpRequestOrigin` carries the derived OAuth callback URL (built
//     from the request's Origin / Host header) so DCR registers a
//     redirect_uri that matches whatever host/port the UI is served on.
//
// The casts are intentional — modifying the oRPC context type is
// invasive, and the properties are invisible to other service methods.

/** Read the pending-state cookie value threaded into context by the Hono layer. */
function pendingState(context: object): string | undefined {
  const value: unknown = (context as { _mcpPendingState?: unknown })._mcpPendingState;
  return typeof value === 'string' ? value : undefined;
}

/** Read the derived OAuth `redirect_uri` threaded into context by the Hono layer. */
function requestOrigin(context: object): string | undefined {
  const value: unknown = (context as { _mcpRequestOrigin?: unknown })._mcpRequestOrigin;
  return typeof value === 'string' ? value : undefined;
}

export const mcpRouter = {
  start: os.mcp.start.handler(({ input, context }) =>
    context.mcp.start(input, requestOrigin(context)),
  ),
  complete: os.mcp.complete.handler(({ input, context }) =>
    context.mcp.complete(input, pendingState(context)),
  ),
  status: os.mcp.status.handler(({ context }) => context.mcp.status(pendingState(context))),
  cancel: os.mcp.cancel.handler(({ input, context }) => context.mcp.cancel(input.state)),
  attachPersonalities: os.mcp.attachPersonalities.handler(({ input, context }) =>
    context.mcp.attachPersonalities(input),
  ),
  list: os.mcp.list.handler(({ context }) => context.mcp.list()),
  delete: os.mcp.delete.handler(({ input, context }) => context.mcp.delete(input)),
  reconnect: os.mcp.reconnect.handler(({ input, context }) => context.mcp.reconnect(input)),
  serverTools: os.mcp.serverTools.handler(({ input, context }) => context.mcp.serverTools(input)),
  personalityServers: os.mcp.personalityServers.handler(({ input, context }) =>
    context.mcp.personalityServers(input),
  ),
  addServer: os.mcp.addServer.handler(({ input, context }) => context.mcp.addServer(input)),
  refreshToken: os.mcp.refreshToken.handler(({ input, context }) =>
    context.mcp.refreshToken(input),
  ),
  rename: os.mcp.rename.handler(({ input, context }) => context.mcp.rename(input)),
  updateToken: os.mcp.updateToken.handler(({ input, context }) => context.mcp.updateToken(input)),
  scopeStatus: os.mcp.scopeStatus.handler(({ input, context }) => context.mcp.scopeStatus(input)),
  validateConfig: os.mcp.validateConfig.handler(({ input, context }) =>
    context.mcp.validateConfig(input),
  ),
  catalog: os.mcp.catalog.handler(({ context }) => context.mcp.catalog()),
};
