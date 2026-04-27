# @ethosagent/acp-server

JSON-RPC 2.0 server that exposes an Ethos `AgentLoop` as an external interface over stdio, HTTP, or WebSocket.

## Why this exists

Ethos as a runtime is useful beyond its own CLI — IDE plugins, web frontends, and other agents need to drive prompts and stream events back. `AcpServer` is the wire-protocol surface that lets those clients speak to a running Ethos process the same way Zed's ACP or the Claude Code SDK is consumed: a single JSON-RPC contract with three interchangeable transports.

The package is intentionally decoupled from `@ethosagent/core` — it depends only on `@ethosagent/types`, `@ethosagent/agent-mesh`, and `ws`. Anything implementing the local `AgentRunner` interface (`run(text, opts) => AsyncGenerator<AgentEvent>`) can be served.

## What it provides

- `AcpServer` — the server class. Accepts `{ runner, session, input?, output?, mesh? }`.
- `AgentRunner` — minimal runner interface (`run(text, opts)` returning an async iterable of agent events). Lets the server be wired to anything event-emitting, not just `AgentLoop`.

## How it works

**Transports.** `start()` runs the JSON-RPC loop over stdio (line-delimited JSON, one message per `\n`). `startHttp(port)` runs an HTTP server with two routes: `POST /rpc` for synchronous request/response, and `GET /ws` for WebSocket sessions that stream events the same way stdio does. Stdio and WebSocket use one shared `dispatch()` path; HTTP is its own blocking handler at `src/index.ts:162` because it cannot stream intermediate events.

**Methods.** `initialize` returns server capabilities. `new_session` mints an `acp:<uuid>` session key. `prompt` runs a turn — over stdio/WS it streams `AgentEvent`s as `$/stream` notifications (`{"jsonrpc":"2.0","method":"$/stream","params":{"requestId":N,"event":...}}`) and resolves with `{text, turnCount}`. `cancel` aborts an in-flight prompt by `requestId`. `fork_session` clones an existing session's full message history into a new `acp:fork:<uuid>` key (`src/index.ts:371`). `resume_session` reports whether a session exists and its message count. `mesh.register` and `mesh.status` are forwarded to the optional `AgentMesh` for multi-agent registration.

**Concurrency.** A `busySessions: Set<string>` prevents two prompts from racing on the same `sessionKey` — a second concurrent `prompt` returns JSON-RPC error `-32000` (`src/index.ts:190`, `src/index.ts:299`). `AbortController`s are tracked per request id so `cancel` can interrupt the runner via the `abortSignal` passed into `runner.run()`. WebSocket connections get their own controller map and abort everything on `close` (`src/index.ts:256`).

**Health.** `GET /health` returns `{ ok, activeSessions }` for liveness probes.

## Configuration

Construction-time only — no env vars or config files. Wiring lives in `apps/ethos/src/commands/acp.ts` (stdio) and `apps/ethos/src/commands/serve.ts` (HTTP + WebSocket + mesh).

When `mesh` is omitted, `mesh.*` methods return `-32000 "Mesh not configured"`.

## Gotchas

- Streaming events are `$/stream` **notifications** (no `id`), not responses. Clients must dispatch on `method === "$/stream"` and correlate via `params.requestId`.
- HTTP `POST /rpc` does not stream — it blocks until the turn completes. Use WebSocket if you need event deltas.
- Every `prompt` request **must** carry a `sessionKey`; the server does not auto-create one. Call `new_session` first.
- The `AgentRunner` type is duplicated locally (`src/index.ts:25`) instead of being imported from core. This is deliberate — keeps the package free of core depends. If you change the `AgentEvent` shape upstream, this file does not break compile but stream consumers may.
- `fork_session` copies up to 10 000 messages via `getMessages(..., {limit: 10_000})`. Sessions longer than that fork lossily.
- The legacy `sendError(id, code, msg)` helper is still used by the stdio path for parse errors before dispatch. Don't remove it.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `AcpServer` class — stdio/HTTP/WebSocket transports + JSON-RPC dispatch. |
| `src/__tests__/acp-server.test.ts` | Vitest coverage for transports, cancel, fork, mesh routing. |
