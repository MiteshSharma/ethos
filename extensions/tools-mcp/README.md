# @ethosagent/tools-mcp

Adapts external Model Context Protocol servers as Ethos tools, exposing each server's tools as `mcp__<server>__<tool>` with auto-reconnect and lifecycle management.

## Why this exists

MCP is the cross-vendor standard for connecting LLMs to tools and data sources. Rather than write bespoke integrations, this package speaks the protocol and surfaces every remote tool as a normal `Tool<TArgs>` object. One config file (`~/.ethos/mcp.json`) gives an Ethos agent access to any MCP server, over either stdio or SSE.

## What it provides

- `McpClient` — wraps one MCP server connection (stdio or SSE), handles reconnect on disconnect, and proxies `listTools` / `callTool`.
- `McpManager` — constructs N clients from a config array, connects them in parallel, and exposes the union of their adapted `Tool` objects.
- `loadMcpConfig()` — reads `~/.ethos/mcp.json` and returns `McpServerConfig[]` (or `[]` if missing).
- `McpServerConfig` — the typed config shape (transport, command/args/env for stdio; url/headers for SSE).

## How it works

`McpClient.connect()` (`src/index.ts:51`) builds a transport via `_createTransport` (`src/index.ts:66`) — `StdioClientTransport` for stdio (with `stderr: 'pipe'`) or a lazy-imported `SSEClientTransport` for SSE so projects that never use SSE don't pay the eventsource dependency cost. On connect, an `onclose` handler rejects every pending call and schedules reconnection via `_scheduleReconnect` (`src/index.ts:94`) using exponential backoff (`1s, 2s, 4s, 8s, 16s`, capped at 30s, max 5 attempts).

`callTool` (`src/index.ts:122`) races the SDK call against a `pending` promise that rejects if the connection drops mid-flight, then flattens MCP `content` blocks of `type: 'text'` into a single string. `isError === true` becomes `{ ok: false, code: 'execution_failed' }`.

`adaptMcpTool` (`src/index.ts:183`) renames each MCP tool to `mcp__<server>__<tool>`, sets `toolset: 'mcp'`, caps results at 50 KB, and wires `isAvailable` to `client.isConnected()` so disconnected servers' tools disappear from the LLM's tool list automatically.

`McpManager.connect()` (`src/index.ts:209`) connects all clients with `Promise.allSettled` — one bad server does not break the rest — and warns to `console.warn` for connect or `listTools` failures. (This package is one of the three explicitly allowed to keep `console.warn` per the root CLAUDE.md.)

## Gotchas

- Tool names embed the server name verbatim — server names with `__` in them will produce ambiguous tool names. Keep server names alphanumeric.
- After a disconnect, in-flight tool calls reject with `MCP server '<name>' disconnected`; the LLM sees `execution_failed`. Reconnection happens in the background and the tool becomes callable again once `isConnected()` returns true.
- Reconnect attempts top out at 5; if the server is still down after the backoff sequence, the client stays disconnected until process restart. There is no manual reconnect API.
- `loadMcpConfig` swallows every read/parse error and returns `[]` — a malformed `~/.ethos/mcp.json` is silently ignored. Validate it manually if servers fail to appear.
- SSE headers are only applied to the initial request via `requestInit.headers`; any per-request auth that the SDK would emit follows MCP SDK behaviour, not this wrapper's.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `McpClient`, `McpManager`, `adaptMcpTool`, `loadMcpConfig`, and the `McpServerConfig` type. |
