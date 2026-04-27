# @ethosagent/tools-delegation

Tools that let an agent spawn local sub-agents (`delegate_task`, `mixture_of_agents`) or hand work off to peer agents over the mesh (`route_to_agent`, `broadcast_to_agents`).

## Why this exists

Some tasks are cleanly separable — research, review, parallel exploration — and benefit from a fresh context window or a different personality. Local delegation reuses the same `AgentLoop` instance with a derived session key. Mesh delegation reaches other Ethos processes over JSON-RPC at `http://<host>:<port>/rpc`, using the registry written by `ethos serve`.

## Tools provided

| Tool name | Toolset | Purpose |
|---|---|---|
| `delegate_task` | `delegation` | Spawn one sub-agent on the same loop with a derived session key and optional personality. |
| `mixture_of_agents` | `delegation` | Run up to 5 sub-agents in parallel; optionally synthesise their outputs through one more sub-agent. |
| `route_to_agent` | `delegation` | Look up a peer in the mesh registry by capability label and call it via JSON-RPC. |
| `broadcast_to_agents` | `delegation` | Send the same prompt to every live mesh agent and return their concatenated responses. |

## How it works

`runSubAgent` (`src/index.ts:25`) drives `loop.run(prompt, ...)` to completion, accumulating `text_delta` events into a single string and breaking on `done`. `delegate_task` derives a child session key as `${ctx.sessionKey}:sub:${label}:${currentTurn}` (`src/index.ts:104`); `mixture_of_agents` uses `:moa:${label}:${currentTurn}` per agent and `:moa:synthesis:${currentTurn}` for the optional synthesis pass (`src/index.ts:201,241`). `Promise.allSettled` is used so one slow or failing agent doesn't block the rest, and a result with zero successes returns an error.

Mesh tools use `@ethosagent/agent-mesh`: `AgentMesh.route(capability)` returns the highest-scoring live agent (`src/index.ts:337`) and `AgentMesh.list()` returns all live agents (`src/index.ts:384`). `callMeshAgent` (`src/index.ts:269`) does two JSON-RPC calls — `new_session` then `prompt` — and forwards the caller's `AbortSignal` so cancelling the parent turn cancels the child fetch.

`createDelegationTools(loop, registryPath?)` (`src/index.ts:428`) returns all four tools; `registryPath` defaults to `defaultRegistryPath()` from the mesh package.

## Gotchas

- Depth tracking relies on `RunOptions.agentId` being threaded into `ToolContext.agentId` by `AgentLoop` (`packages/core/src/agent-loop.ts`). If you swap in a custom loop runner that doesn't honor `opts.agentId`, `MAX_SPAWN_DEPTH` is silently disabled — children read depth as `0` and recursion is unbounded.
- `mixture_of_agents` synthesis runs as another sub-agent without a personality override — it inherits whatever the loop is configured with.
- `broadcast_to_agents` includes a trailing `*N agent(s) failed: …*` block when some peers fail but at least one succeeded; the failure messages are raw `String(reason)`, which may include `Error:` prefixes.
- The mesh tools talk plain HTTP — no TLS, no auth — so they assume the registry only contains trusted peers on localhost or a private network.
- `route_to_agent` does **not** fall back to local execution when no peer matches; it returns `execution_failed` (the tool's own description states this).

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | All four tool factories, `runSubAgent`, `callMeshAgent`, depth helpers, and `createDelegationTools`. |
