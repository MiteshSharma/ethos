---
title: "AgentEvent reference"
description: "Every AgentEvent variant: payload shape, when it is emitted, and which surfaces render it."
kind: reference
audience: developer
slug: agent-event
updated: 2026-07-03
---

`AgentEvent` is the streaming event type yielded by `AgentLoop.run()`. Every surface that renders a [turn](../../getting-started/glossary.md#turn) — CLI, TUI, web UI, channel adapters — consumes this stream and renders the variants it cares about.

## Source {#source}

Defined in [`packages/core/src/agent-loop.ts`](https://github.com/MiteshSharma/ethos/blob/main/packages/core/src/agent-loop.ts). Re-exported from `@ethosagent/core` as `AgentEvent`.

## Signature {#signature}

```ts
import type { AgentEvent } from '@ethosagent/core';

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
  | {
      type: 'tool_progress';
      toolName: string;
      message: string;
      percent?: number;
      audience: 'internal' | 'user';
    }
  | {
      type: 'tool_end';
      toolCallId: string;
      toolName: string;
      ok: boolean;
      durationMs: number;
      audience?: 'internal' | 'user';
      result?: string;
      error?: string;
    }
  | { type: 'usage'; inputTokens: number; outputTokens: number; estimatedCostUsd: number }
  | { type: 'error'; error: string; code: string }
  | { type: 'done'; text: string; turnCount: number }
  | {
      type: 'halt';
      kind: 'budget' | 'watcher';
      rule: string;
      toolName?: string;
      count?: number;
      message: string;
    }
  | { type: 'context_meta'; data: Record<string, unknown> }
  | {
      type: 'run_start';
      provider: string;
      model: string;
      source: 'team-coordinator' | 'team-personality' | 'personality' | 'global';
    };
```

## Variants {#variants}

| `type` | When emitted | Payload fields |
|---|---|---|
| [`run_start`](#run-start) | Once at the start of each turn, before any LLM call. | `provider`, `model`, `source` |
| [`context_meta`](#context-meta) | Once after context injectors run. | `data` |
| [`text_delta`](#text-delta) | Each token of assistant text from the LLM stream. | `text` |
| [`thinking_delta`](#thinking-delta) | Each token of extended-thinking output (when the provider supports it). | `thinking` |
| [`tool_start`](#tool-start) | Once per [tool](../../getting-started/glossary.md#tool) call, immediately before execution. | `toolCallId`, `toolName`, `args` |
| [`tool_progress`](#tool-progress) | Zero or more times per tool call while it runs. | `toolName`, `message`, `percent?`, `audience` |
| [`tool_end`](#tool-end) | Once per tool call after execution returns or throws. | `toolCallId`, `toolName`, `ok`, `durationMs`, `audience?`, `result?`, `error?` |
| [`usage`](#usage) | Once per LLM call, after the response completes. | `inputTokens`, `outputTokens`, `estimatedCostUsd` |
| [`halt`](#halt) | When the loop stops the turn early — a per-turn tool budget tripped or the safety watcher paused. | `kind`, `rule`, `toolName?`, `count?`, `message` |
| [`error`](#error) | When a turn aborts (uncaught LLM error, hook failure, abort signal). | `error`, `code` |
| [`done`](#done) | Once at the end of a successful turn. Always the last event. | `text`, `turnCount` |

### run_start {#run-start}

Emitted before any LLM call so consumers can surface the effective provider and model for the turn. `source` indicates which routing rule selected the model — useful for telemetry that wants to attribute cost to the team or personality layer.

### context_meta {#context-meta}

Emitted after every [`ContextInjector`](./hook-registry.md#available-hook-points) writes to `PromptContext.meta`. The `data` blob is the merged map; surfaces that show injector provenance (e.g. the web drawer) consume this. Skip if you do not display injector telemetry.

### text_delta {#text-delta}

Each chunk of assistant text streamed from the LLM. Concatenating every `text_delta.text` in order rebuilds the assistant response. Whitespace is preserved as-is; do not normalise.

### thinking_delta {#thinking-delta}

Extended-thinking tokens. Anthropic models with `thinkingBudget` set produce these; OpenAI-compatible providers do not. Surface them in a separate visual lane (collapsed by default) or drop them entirely.

### tool_start {#tool-start}

Fires once per [tool](../../getting-started/glossary.md#tool) call, immediately before `Tool.execute` runs. `toolCallId` is stable for the whole call — match it against `tool_progress` and `tool_end` events to assemble per-call UI.

### tool_progress {#tool-progress}

Emitted by tools via `ToolContext.emit({ type: 'progress', ... })`. The `audience` field is the [audience boundary](../../getting-started/glossary.md#audience-boundary) gate.

| `audience` | Who renders it |
|---|---|
| `'internal'` (default) | Framework only — logs, telemetry, dev TUI. Channel adapters and the CLI chat REPL MUST drop it. |
| `'user'` | Explicit per-event opt-in by the tool author. Surfaced in user-facing streams (CLI, channel messages). |

The framework never opts in for the tool. Budget-warning events emitted by `AgentLoop` itself use `audience: 'user'`.

### tool_end {#tool-end}

Fires once per tool call. `ok: true` indicates the tool returned a success `ToolResult`; `ok: false` indicates an error (including hook-rejected calls). `result` carries the success value or error message — optional so consumers that only render status chips can ignore it. `error` is set only when `ok: false` and carries the `ToolResult` error message, so consumers that track failures (e.g. the goal runner's failure-streak detection) never parse `result`. The audience boundary applies to success cases only; failures always render.

### usage {#usage}

Per-LLM-call token + cost accounting. Emitted after every LLM round-trip — a turn that triggers tool calls emits a `usage` event for each round. Sum across the turn to get total cost.

### halt {#halt}

Fires when the loop stops the turn early for safety, alongside a user-facing `tool_progress` carrying the same message. Not terminal — a normal `done` still follows, so consumers that judge or persist turn output (e.g. the goal runner) use `halt` to know the output is truncated, not clean.

| `kind` | Emitted when | `rule` values |
|---|---|---|
| `'budget'` | A per-turn tool budget or the session cost cap tripped before the next LLM call. | `tool-budget` — total calls hit `maxToolCallsPerTurn`; `identical-name` — one tool name hit `maxIdenticalToolCalls`; `identical-streak` — consecutive identical name+args calls hit the streak cap; `cost-cap` — accumulated session spend reached the personality's `budgetCapUsd`. |
| `'watcher'` | The safety watcher paused the turn (a non-terminate decision). | The watcher rule id (e.g. `compounding-error`). |

`toolName` and `count` are set for budget halts (`toolName` is `_budget` for the total-calls and `cost-cap` rules; `cost-cap` carries no `count`). Watcher *terminations* are not halts — they remain terminal [`error`](#error) events with a `watcher_<rule>` code.

### error {#error}

Terminal error. After this fires the turn is over; no further events are emitted. `code` is a stable identifier (`abort`, `llm_timeout`, `provider_unauthorized`, `tool_unknown`, etc.) safe for switch-statement dispatch.

### done {#done}

Always the last event of a successful turn. `text` is the full concatenated assistant response (equivalent to joining all `text_delta.text` values). `turnCount` is the cumulative count for the session.

## Notes {#notes}

- The stream always ends with exactly one of `done` or `error`. Consumers must handle both.
- `halt` is not a terminator — it precedes a normal `done`. A turn with a `halt` produced truncated output.
- `tool_progress` events are unordered with respect to other events from the same tool — only `tool_start` (first) and `tool_end` (last) are guaranteed bracketing markers per `toolCallId`.
- `text_delta` and `thinking_delta` may interleave with `tool_start` / `tool_end` when the LLM streams tool calls inline with text.
- `audience: 'internal'` is the default when absent. Surface code that fans events out to humans must filter explicitly.
- `tool_end.result` is best-effort. CLI status chips and telemetry collectors that only need ok/duration may ignore it; expandable UIs (web drawer) use it to avoid a follow-up history fetch.
- A turn may include multiple LLM round-trips when the LLM calls tools. Each round emits its own `usage` event; sum across the turn for total cost.
- `error` is terminal — no `done` follows. Consumers MUST close UI affordances (spinners, "agent thinking…") on both terminators.

## Event ordering example {#event-ordering-example}

A turn where the LLM calls one tool then produces a final answer typically streams events in this order:

```
run_start                 (provider, model, source)
context_meta              (injector metadata)
text_delta * N            (assistant reasoning text)
tool_start                (toolCallId=t1, toolName=read_file, args={...})
tool_progress * M         (audience='internal' by default)
tool_end                  (toolCallId=t1, ok=true, durationMs=120)
usage                     (inputTokens/outputTokens for round 1)
text_delta * K            (assistant final answer)
usage                     (inputTokens/outputTokens for round 2)
done                      (text, turnCount)
```

Channel adapters that only render user-visible output filter to `text_delta` plus `tool_end` (when `ok` and `audience === 'user'`) plus `error` / `done`.

## Used by {#used-by}

| Consumer | Role |
|---|---|
| `apps/ethos/src/commands/chat.ts` | CLI REPL — renders text deltas, tool chips, and the final response. |
| `apps/tui/src/components/App.tsx` | Interactive TUI — full event-stream rendering. |
| `apps/web/src/lib/chat-reducer.ts` | Web UI — reducer that maps events to message state. |
| `apps/web/src/lib/drawer-reducer.ts` | Web UI — tool-call drawer that consumes `tool_start` / `tool_end` / `context_meta`. |
| `apps/vscode-extension/src/bridge.ts` | VS Code bridge — forwards events to the webview. |
| `apps/acp-server/src/index.ts` | ACP server — wire-protocol mapping of events. |
| `extensions/gateway/src/` | Channel gateway — filters by audience before dispatching to adapters. |
| `extensions/eval-harness/src/runner.ts` | Eval runner — collects events to score turns. |

## See also {#see-also}

- [LLMProvider interface](./llm-provider-interface.md) — emits `CompletionChunk` which `AgentLoop` translates into `AgentEvent`.
- [Tool interface](./tool-interface.md) — `ToolContext.emit` produces `tool_progress` events.
- [Audience boundary](../explanation/audience-boundary.md) — why `tool_progress` and `tool_end` carry an `audience` field.
- [Glossary: AgentEvent](../../getting-started/glossary.md#agent-event) — one-line definition; cross-referenced from every page that mentions the stream.
