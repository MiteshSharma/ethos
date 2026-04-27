# @ethosagent/agent-mesh

File-backed registry of running Ethos agents — capability advertising, heartbeats, and least-busy routing for delegation between peers.

## Why this exists

When more than one Ethos process is running on a machine (or LAN), tools like `delegate` need a way to ask "who can do X right now?" and route the work. `AgentMesh` is the small piece of shared state that answers that question without standing up a coordination service: it's a JSON file under `~/.ethos/`, scanned on every read, with stale entries garbage-collected on every write.

There is no daemon. No socket. The mesh is a lock-free shared file plus a 10-second heartbeat from each participant.

## What it provides

- `AgentMesh` — register / heartbeat / unregister / route / list / startHeartbeat.
- `MeshEntry` — interface for an entry: `agentId`, `capabilities[]`, `model`, `pid`, `host`, `port`, `registeredAt`, `lastHeartbeatAt`, `activeSessions`.
- `defaultRegistryPath()` — returns `~/.ethos/mesh-registry.json`.

## How it works

**Storage.** Every operation reads and re-writes the entire JSON file. `read()` swallows parse errors and returns `[]`, so a corrupt registry self-heals on the next `write()`. The directory is created on first write (`src/index.ts:48`). The file is plain JSON — `cat ~/.ethos/mesh-registry.json` is the debugger.

**Liveness.** An entry is "live" if `now - lastHeartbeatAt < 30_000` ms. Stale entries are filtered out on every `write()` and on every `list()` / `route()` read (`src/index.ts:41`, `src/index.ts:103`). Agents call `startHeartbeat(agentId, getActiveSessions)` which fires every 10 s — three missed beats and the entry vanishes.

**Routing.** `route(capability)` filters live entries by capability membership, then picks the least-busy candidate (`activeSessions` ascending). Tie-break is `registeredAt` ascending, so the longest-running agent wins ties — a small bias toward warm processes (`src/index.ts:84`).

**Re-registration.** Calling `register()` for an existing `agentId` preserves the original `registeredAt` and only refreshes `lastHeartbeatAt`. This means restart-then-reregister doesn't reset tie-break order (`src/index.ts:56`).

**Caps.** Hard cap of 100 entries — if exceeded, the newest by `registeredAt` win (`src/index.ts:43`). This is a safety valve, not a designed limit.

## Configuration

Constructor takes an optional registry path. Default is `~/.ethos/mesh-registry.json`. No env vars.

Each entry advertises `host` and `port` — these are the coordinates a peer uses to reach the agent over `@ethosagent/acp-server`'s HTTP/WebSocket transport. The mesh itself does no networking; it just publishes the address book.

## Gotchas

- **Not concurrency-safe across processes.** Two agents writing simultaneously can race — last writer wins. In practice, registers/heartbeats are infrequent and entries are independent rows, so collisions are rare. If you need stronger guarantees, wrap calls in an external lock.
- `STALE_MS` and the 10 s heartbeat interval are hard-coded. If you tune one, tune both — heartbeats must arrive at least 3× more often than the stale window.
- `route()` returns `null` when no live agent has the capability — callers must handle that. There's no fallback to "least bad" stale candidate.
- `startHeartbeat()` returns a cleanup function. Callers (e.g. `extensions/tools-delegation`) **must** invoke it on shutdown or the registry accumulates ghost entries until they age out.
- `read()` returns `[]` on any error including a missing file. There's no way to distinguish "first run" from "registry corrupted" — neither is actionable, so it doesn't matter, but don't rely on errors propagating.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `AgentMesh` class, `MeshEntry` type, `defaultRegistryPath()`. |
| `src/__tests__/agent-mesh.test.ts` | Vitest coverage for register/heartbeat/route/staleness/cap. |
