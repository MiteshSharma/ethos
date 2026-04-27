# @ethosagent/gateway

Bridges inbound messages from any `PlatformAdapter` into an `AgentLoop`, derives per-platform session lanes, serialises concurrent turns per chat, and handles built-in slash commands.

## Why this exists

Platform adapters (Slack, Telegram, Discord, etc.) all emit the same `InboundMessage` shape from `@ethosagent/types` but each has its own quirks: webhook retries, polling reconnects, double-delivery, typing indicators with short TTLs. The Gateway is the one place that turns "an adapter heard something" into "an agent ran a turn and replied" — applying dedup, ordering, lane isolation, slash commands, usage accounting, and graceful shutdown uniformly across every platform.

## What it provides

- `Gateway` — main class, accepts `{ loop, defaultPersonality?, maxConcurrentSessions?, dedupWindow? }`.
- `SessionLane` — per-chat FIFO queue with abort-the-current-and-drop-the-rest semantics.
- `GatewayConfig` — config interface.

## How it works

**Lane derivation.** Every inbound message is keyed `${platform}:${chatId}` (e.g. `telegram:-1001234`, `slack:C9XYZ`). Each lane gets its own `SessionLane`. Turns within a lane execute strictly in order; different lanes run concurrently. The session key passed into `AgentLoop` defaults to the lane key but can be replaced with `${laneKey}:${Date.now()}` after `/new` to start a fresh history (`src/index.ts:169`).

**Dedup.** Before any work, `isDuplicate(message)` checks a bounded `Set<string>` of recent `(platform, chatId, messageId)` triples. The window defaults to 1024 and is FIFO-evicted (`src/index.ts:130`). Adapters that don't populate `messageId` skip dedup — there's no key. This protects against billing duplication from polling reconnects and webhook retries (OpenClaw #71761).

**Slash commands.** Handled by Gateway *before* the `AgentLoop` sees the text. The set is fixed: `/new` and `/reset` (fork session, clear usage, reset personality), `/stop` (abort current turn + drop queued), `/usage` (per-lane token / cost totals), `/personality` (show / list / switch — switching also forks a new session so identity takes effect immediately, `src/index.ts:215`), `/help`. Recognition is case-insensitive on the first whitespace-separated token (`src/index.ts:158`).

**Turn execution.** Inside the lane, the Gateway sends a typing indicator immediately, then renews it every 4 s (Telegram's typing TTL is ~5 s — `src/index.ts:245`). Streams `AgentLoop` events: accumulates `text_delta` chunks, increments per-lane usage on each `usage` event, and breaks on `done` or `error`. Final text is sent as one `parseMode: 'markdown'` message to the adapter. `sendTyping` and `send` failures are swallowed (`.catch(() => {})`) — chat platforms drop messages routinely and the lane must keep moving.

**SessionLane.** A simple Promise-chained FIFO. `enqueue()` returns a Promise that resolves after the task runs. `abort()` calls `currentAbort.abort()` on the in-flight task and rejects every queued task with `new Error('aborted')` (`src/index.ts:27`). Drain logic guarantees only one task runs at a time per lane.

**Graceful shutdown.** `shutdown({ notify })` sends `notify` text to every chat with an active turn before aborting all lanes (`src/index.ts:290`). This avoids the silent-drop problem from OpenClaw #71178 where mid-turn restarts left users staring at a typing indicator forever.

## Configuration

- `loop` (required) — an `AgentLoop` instance.
- `defaultPersonality` — falls back to `'default'` for the `/help` display and is passed into `loop.run()` when no per-lane override is set.
- `dedupWindow` — bounded LRU size for inbound dedup. Default `1024`. Set to `0` to disable.
- `maxConcurrentSessions` — present in the type but **not currently enforced** (no max-lane logic in `src/index.ts`). The expectation is queueing per lane, not a global cap.

## Gotchas

- Adapters **must** populate `InboundMessage.messageId` to get dedup. Adapters without stable IDs are vulnerable to webhook retry storms — they will be billed twice.
- `/new` and `/personality <id>` both fork a session by writing `${laneKey}:${Date.now()}`. If two `/new` commands arrive in the same millisecond, they will collide. In practice impossible, but worth knowing.
- The reply is always sent as a single `parseMode: 'markdown'` message. Adapters that can't render markdown should normalise on the way out.
- Send failures inside the turn loop are silently swallowed. There is intentionally no retry — the adapter owns retry semantics for its platform.
- The slash command list is hard-coded (`PLATFORM_COMMANDS`, `src/index.ts:86`). Adding a command means editing this file, not registering elsewhere.
- `sessionLane.length` includes the in-flight task. The "currently processing" task counts as 1.
- Lanes are never garbage collected — once a chat has produced a message, its `SessionLane` and entries in `sessionKeys` / `personalityIds` / `usageStore` live for the process lifetime. Fine for typical bot deployments; a concern for very long-running multi-tenant gateways.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `Gateway`, `SessionLane`, slash-command table, shutdown handling. |
| `src/__tests__/gateway.test.ts` | Vitest coverage for dedup, lanes, slash commands, abort, shutdown. |
