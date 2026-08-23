---
title: "HookRegistry reference"
description: "HookRegistry interface, DefaultHookRegistry implementation, and every hook point Ethos fires."
kind: reference
audience: developer
slug: hook-registry
updated: 2026-07-10
---

A [hook](../../getting-started/glossary.md#hook) is a handler that fires at a named extension point inside [`AgentLoop`](./agent-event.md) or the channel gateway. The `HookRegistry` is the lookup table mapping hook names to handlers; `DefaultHookRegistry` is the in-memory implementation `AgentLoop` ships with.

## Source {#source}

Interface in [`packages/types/src/hooks.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/hooks.ts). Implementation in [`packages/core/src/hook-registry.ts`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/hook-registry.ts).

## HookRegistry {#hook-registry}

### Signature {#hook-registry-signature}

```ts
import type { HookRegistry } from '@ethosagent/types';

export interface HookRegistry {
  registerVoid<K extends keyof VoidHooks>(
    name: K,
    handler: (payload: VoidHooks[K]) => Promise<void>,
    opts?: { pluginId?: string; failurePolicy?: 'fail-open' | 'fail-closed' },
  ): () => void;

  registerModifying<K extends keyof ModifyingHooks>(
    name: K,
    handler: (payload: ModifyingHooks[K][0]) => Promise<Partial<ModifyingHooks[K][1]> | null>,
    opts?: { pluginId?: string },
  ): () => void;

  registerClaiming<K extends keyof ClaimingHooks>(
    name: K,
    handler: (payload: ClaimingHooks[K][0]) => Promise<ClaimingHooks[K][1]>,
    opts?: { pluginId?: string },
  ): () => void;

  fireVoid<K extends keyof VoidHooks>(
    name: K,
    payload: VoidHooks[K],
    allowedPlugins?: string[],
  ): Promise<void>;

  fireModifying<K extends keyof ModifyingHooks>(
    name: K,
    payload: ModifyingHooks[K][0],
    allowedPlugins?: string[],
  ): Promise<ModifyingHooks[K][1]>;

  fireClaiming<K extends keyof ClaimingHooks>(
    name: K,
    payload: ClaimingHooks[K][0],
    allowedPlugins?: string[],
  ): Promise<ClaimingHooks[K][1]>;

  unregisterPlugin(pluginId: string): void;
}
```

### Methods {#hook-registry-methods}

| Method | Returns | Description |
|---|---|---|
| `registerVoid` | `() => void` | Subscribe to a fire-and-forget hook. The returned closure unregisters. |
| `registerModifying` | `() => void` | Subscribe to a hook that may amend payloads. Handlers see the unmodified payload; results are merged. |
| `registerClaiming` | `() => void` | Subscribe to a routing hook. The first handler to return `{ handled: true }` wins. |
| `fireVoid` | `Promise<void>` | Fan out to every void handler in parallel via `Promise.allSettled`. Fail-open: rejected handlers are swallowed. |
| `fireModifying` | `Promise<MergedResult>` | Run handlers sequentially. Merge results — first non-null value per key wins. |
| `fireClaiming` | `Promise<ClaimResult>` | Run handlers sequentially. Stop at the first `{ handled: true }`; otherwise return `{ handled: false }`. |
| `unregisterPlugin` | `void` | Remove every handler registered with the given `pluginId`. |

### opts.pluginId {#opts-plugin-id}

When a plugin registers a hook, the SDK passes `opts.pluginId`. AgentLoop's `fire*` calls receive `allowedPlugins` (derived from the active [personality](../../getting-started/glossary.md#personality)'s `plugins` config); plugin-registered handlers fire only when their `pluginId` is in that list. Built-in handlers (no `pluginId`) always fire.

| `allowedPlugins` | Effect |
|---|---|
| `undefined` | No filter — every handler fires. |
| `[]` | Only built-in handlers fire. |
| `['plugin-a']` | Built-in handlers plus handlers tagged `plugin-a`. |

### opts.failurePolicy {#opts-failure-policy}

Void hooks only. Defaults to `'fail-open'` (errors are logged, swallowed). `'fail-closed'` propagates the rejection — reserve for hooks where a silent failure is unacceptable (auditing, billing). The default registry implementation logs and swallows regardless; `'fail-closed'` is enforced by `AgentLoop` consumers that wrap the call.

## Execution models {#execution-models}

| Model | Method | Semantics | Use for |
|---|---|---|---|
| Void | `fireVoid` | Parallel; `Promise.allSettled`; failures dropped. | Logging, analytics, notifications, telemetry. |
| Modifying | `fireModifying` | Sequential; merged results; first non-null key wins. | Amending the prompt, overriding tool args. |
| Claiming | `fireClaiming` | Sequential; stop at first `{ handled: true }`. | Routing decisions: which platform handles this message. |

See [hook-execution-models](../explanation/hook-execution-models.md) for the design rationale.

## Available hook points {#available-hook-points}

Payload + result types live in [`packages/types/src/hooks.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/hooks.ts).

### Void hooks {#void-hooks}

| Name | Payload | When it fires |
|---|---|---|
| `session_start` | `SessionStartPayload` | First turn of a session, before any LLM call. |
| `before_llm_call` | `BeforeLLMCallPayload` | Immediately before each LLM round-trip. |
| `after_llm_call` | `AfterLLMCallPayload` | After each LLM round-trip completes. |
| `after_tool_call` | `AfterToolCallPayload` | After each tool's `execute` returns. |
| `tool_end_with_path` | `ToolEndWithPathPayload` | After a tool call whose args referenced a filesystem path. |
| `agent_done` | `AgentDonePayload` | At the end of each turn, after the final `done` event. |
| `message_received` | `MessageReceivedPayload` | When the gateway accepts an inbound channel message. |
| `message_sent` | `MessageSentPayload` | When the gateway has dispatched an outbound message. |
| `subagent_spawned` | `SubagentSpawnedPayload` | After `tools-delegation` spawns a subagent session. |
| `subagent_ended` | `SubagentEndedPayload` | When a subagent session ends. |
| `after_ticket_revision` | `AfterTicketRevisionPayload` | After `kanban_complete` was rejected by a `before_ticket_complete` verifier and the ticket was moved to `needs_revision`. |
| `ticket_claimed` | `TicketClaimedPayload` | After a task is claimed and moves to `running`. |
| `ticket_blocked` | `TicketBlockedPayload` | After `kanban_block` commits the block transition. |
| `ticket_completed` | `TicketCompletedPayload` | After `kanban_complete`'s `running -> done` transition commits — the successful-completion path only. |
| `ticket_stale_reclaimed` | `TicketStaleReclaimedPayload` | Around `Dispatcher.tick()`'s `reclaimTask` call, when a stuck `running` task is re-queued to `ready` (owner gone or heartbeat stale). |
| `ticket_updated` | `TicketUpdatedPayload` | On a ticket field mutation outside the status/block/complete lifecycle — today, `kanban_assign` and `KanbanService.assign`. |
| `dispatch_tick` | `DispatchTickPayload` | At the bottom of `Dispatcher.tick()`, but only when `claimedCount > 0 \|\| reclaimedCount > 0` — an idle tick does not fire it. |

### Modifying hooks {#modifying-hooks}

| Name | Payload → Result | When it fires |
|---|---|---|
| `before_prompt_build` | `BeforePromptBuildPayload` → `BeforePromptBuildResult` | Before the system prompt is assembled — handlers can prepend, append, or override. |
| `before_tool_call` | `BeforeToolCallPayload` → `BeforeToolCallResult` | Before each tool's `execute` runs — handlers can amend `args` or set `error` to reject. |
| `message_sending` | `MessageSendingPayload` → `MessageSendingResult` | Before an outbound message hits an adapter — handlers can rewrite the message. |
| `personality_switched` | `PersonalitySwitchedPayload` → `PersonalitySwitchedResult` | After `/personality` switches identities — handlers can substitute a different config. |
| `subagent_spawning` | `SubagentSpawningPayload` → `SubagentSpawningResult` | Before a subagent session starts — handlers can rewrite prompt or pick a different personality. |

### Claiming hooks {#claiming-hooks}

| Name | Payload → Result | When it fires |
|---|---|---|
| `inbound_claim` | `InboundClaimPayload` → `InboundClaimResult` | Gateway dispatch: which adapter owns this inbound message? |
| `before_dispatch` | `BeforeDispatchPayload` → `BeforeDispatchResult` | Outbound dispatch: short-circuit handlers (e.g. dedup) can mark a message as handled to suppress send. |
| `before_ticket_complete` | `BeforeTicketCompletePayload` → `BeforeTicketCompleteResult` | Fired by `kanban_complete` before the `running → done` transition. A handler returning `{ handled: true, reason }` rejects the completion; the ticket moves to `needs_revision` instead, then `after_ticket_revision` fires. Opt-in in single-personality deployments — with no handler registered, `fireClaiming` returns `{ handled: false }` and completion proceeds. In team deployments (config `teamName` set) a default verifier handler (eval-harness scoring pass) is wired since Phase 7, making the review state non-skippable there. |

### Hook point payload reference {#hook-point-payloads}

Key payload fields — see [`packages/types/src/hooks.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/hooks.ts) for the full type definitions.

| Payload | Notable fields |
|---|---|
| `SessionStartPayload` | `sessionId`, `sessionKey`, `platform`, `personalityId?` |
| `BeforePromptBuildPayload` | `sessionId`, `personalityId?`, `history: StoredMessage[]` |
| `BeforeLLMCallPayload` | `sessionId`, `model`, `turnNumber` |
| `AfterLLMCallPayload` | `sessionId`, `text`, `usage: { inputTokens, outputTokens }` |
| `BeforeToolCallPayload` | `sessionId`, `toolCallId`, `toolName`, `args` |
| `AfterToolCallPayload` | `sessionId`, `toolName`, `result: ToolResult`, `durationMs` |
| `ToolEndWithPathPayload` | `sessionId`, `personalityId?`, `toolName`, `filePath`, `workingDir` |
| `AgentDonePayload` | `sessionId`, `text`, `turnCount`, `personalityId?`, `successfulToolCalls?`, `totalToolCalls?`, `toolNames?`, `initialPrompt?` |
| `MessageReceivedPayload` | `message: InboundMessage`, `sessionId?` |
| `MessageSendingPayload` | `chatId`, `message: OutboundMessage` |
| `InboundClaimPayload` | `message: InboundMessage` |
| `BeforeDispatchPayload` | `chatId`, `platform`, `text` |
| `PersonalitySwitchedPayload` | `sessionId`, `from?`, `to` |
| `SubagentSpawningPayload` | `parentSessionId`, `prompt`, `personalityId?` |
| `BeforeTicketCompletePayload` | `taskId`, `summary`, `acceptanceCriteria?`, `autonomyTier?` |
| `AfterTicketRevisionPayload` | `taskId`, `summary`, `acceptanceCriteria?`, `reason`, `assignee`, `autonomyTier?`, `successRatio?` |

Result types follow the same naming (`BeforeToolCallResult`, etc.) and only carry the fields a handler may override.

## Notes {#notes}

- `before_tool_call` returning `{ error: '...' }` does NOT skip the tool by itself — `AgentLoop` reads the result, adds the call to a rejected list, persists an `is_error: true` tool_result, and then excludes the call from `executeParallel`. Hooks must return the error; the loop enforces the skip.
- The Anthropic message contract requires a `tool_result` block for every `tool_use` block in the preceding assistant message. Even rejected tool calls must produce a `tool_result` (with `is_error: true`) — `AgentLoop` handles this; hooks just return the rejection reason.
- `fireModifying` merges results into an object where the first non-null value per key wins. Handlers that want to "win" should run early; ordering follows registration order. `null` results are skipped (use `null` as the "no opinion" return).
- `fireClaiming` is fail-open: a thrown handler is skipped and iteration continues. Returning `{ handled: false }` is the normal "pass" outcome.
- `unregisterPlugin` removes every handler tagged with the plugin id from all three maps. The plugin loader uses this during `deactivate`.
- The void-hook return closures (`() => void`) are useful in tests — collect them in an array and call all on teardown.
- Channel-routing hooks (`inbound_claim`, `before_dispatch`) live in the [gateway](../../getting-started/glossary.md#gateway), not `AgentLoop`. They are part of the same `HookRegistry` instance so plugins can register against either.

## Used by {#used-by}

| Consumer | Role |
|---|---|
| `packages/core/src/agent-loop.ts` | Fires every hook in the turn cycle. |
| `extensions/gateway/src/` | Fires `inbound_claim`, `before_dispatch`, `message_received`, `message_sent`. |
| `extensions/tools-terminal/src/guard.ts` | Registers a `before_tool_call` handler for command allowlisting. |
| `packages/safety/channel/src/` | Channel-safety guards via `before_dispatch` and `message_received`. |
| `packages/safety/injection/src/` | Injects classifier verdicts via `before_prompt_build` and `before_tool_call`. |
| `extensions/skill-evolver/src/evolver.ts` | Listens on `agent_done` to queue skill-candidate analysis. |
| `extensions/observability-sqlite/src/` | Persists `usage`, `tool_end`, and `agent_done` via void hooks. |
| `packages/plugin-sdk/src/index.ts` | `EthosPluginApi.registerVoidHook` / `registerModifyingHook` delegate here. |

## See also {#see-also}

- [Hook execution models](../explanation/hook-execution-models.md) — why three models, not one.
- [Tool interface](./tool-interface.md) — `before_tool_call` mutates `args` before `execute`.
- [How to add a hook](../how-to/add-a-hook.md) — task-shaped recipe for picking a model and wiring a handler.
- [Plugin SDK reference](./plugin-sdk.md) — how plugins register hooks safely.
- [Glossary: Hook](../../getting-started/glossary.md#hook) — one-line definition of the extension point.
