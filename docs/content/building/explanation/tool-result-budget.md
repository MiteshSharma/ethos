---
title: "Why is there an 80k tool result budget?"
description: "A turn-wide character cap on tool output, split evenly across concurrent calls. Bounds context-window growth without forcing tools to coordinate."
kind: explanation
audience: developer
slug: tool-result-budget
updated: 2026-05-12
---

## Context

A [tool](../../getting-started/glossary.md#tool) returns a string. The string becomes a `tool_result` block in the LLM's next prompt. The model reads it on the way to deciding what to do next. Strings cost tokens; tokens cost money and context. Tools that produce unbounded output kill turns — they fill the context window with file contents or web pages and leave no room for the model to think.

Ethos defends against this with a turn-wide budget. `AgentLoop` sets `resultBudgetChars: 80_000` by default. `ToolRegistry.executeParallel` splits that budget evenly across the tool calls in the turn. Each call's output is post-trimmed and marked `[truncated]` if it exceeds its share. Tools can declare a lower `maxResultChars` to opt into stricter limits per call.

This page is about why 80k, why split rather than per-call, and when a tool author should set a lower `maxResultChars`.

## Discussion

### The 80k number is context-window math, not a guess

Anthropic's flagship Claude models accept a context window in the low hundreds of thousands of tokens. Roughly four characters per token (English text, not code), so 80,000 characters is around 20,000 tokens of tool output budget per turn.

Subtract that from a 200k-token window and you have ~180k tokens left for the system prompt, memory, conversation history, the model's thinking, the model's reply, and headroom for the next iteration of the loop. The math:

- System prompt + [personality](../../getting-started/glossary.md#personality) identity + memory: ~5–15k tokens.
- Conversation history (200 messages cap): variable, often 20–80k tokens.
- Model output (thinking + reply): ~5–20k tokens per turn.
- Cache headroom for multi-turn streams: variable.

80k characters of tool output is the largest cap that comfortably fits beneath the rest without making long sessions feel cramped. Smaller models (OpenAI-compat with shorter windows) can override via `AgentLoopConfig.options.resultBudgetChars`; the default targets the dominant case.

The number is a budget, not a target. Many turns consume far less. The point is the *cap* — a runaway tool cannot eat the rest of the window.

### Split per-call, not per-tool

The split is the load-bearing piece. When the model returns multiple `tool_use` blocks in one assistant message — "read these three files in parallel" — `ToolRegistry.executeParallel` runs them concurrently. Concretely from `packages/core/src/tool-registry.ts`:

```typescript
const perCallBudget = Math.floor(ctx.resultBudgetChars / Math.max(calls.length, 1));
```

Three parallel calls get `80_000 / 3 = 26,666` characters each. Five parallel calls get 16,000 each. The math is per-turn, so a single tool call in one turn gets the full 80k.

This is the alternative to a per-tool cap. A static 20k-per-tool limit would mean four parallel reads can together produce 80k, but a single-tool turn can only produce 20k — a turn that should have used the full window is shortchanged. The dynamic split flips it: a single-tool turn gets the full headroom, a multi-tool turn shares it. The model does not have to know the number; it produces tool calls and the framework allocates the budget.

The post-trim is the enforcement. Each tool's `execute` returns a `string` (when `ok: true`); the registry inspects its length and rewrites the result if it exceeds the share:

```typescript
if (result.ok && result.value.length > budget) {
  return {
    ok: true,
    value: `${result.value.slice(0, budget)}\n[truncated — ${result.value.length} chars total]`,
  };
}
```

The truncation marker is part of the contract. The model sees the marker, knows the result was truncated, knows the original size. Its next turn can ask for less (a smaller page, a filtered query) without the framework explaining itself.

### Tools declare lower `maxResultChars` when their output is structurally bounded

The per-call budget is a ceiling. A tool can declare a tighter limit via `maxResultChars`. The actual budget per call is:

```typescript
const budget = Math.min(perCallBudget, entry.tool.maxResultChars ?? perCallBudget);
```

A `read_file` tool with `maxResultChars: 20_000` will never produce more than 20,000 characters in any turn, even when it is the only call and the per-call budget is 80k. This is the right choice for tools where larger output would be wasted:

- `read_file` uses pagination — the model asks for a specific chunk, and chunks are bounded. A 20k cap forces the model to paginate explicitly rather than slurp.
- `web_search` returns a result list. 100 results is plenty; 10,000 is noise. A 30k cap keeps the result legible.
- `delegate_task` returns a sub-agent's final text. A 20k cap keeps coordination costs bounded — the parent does not pay full context for a sub-agent's intermediate work.

The pattern: declare `maxResultChars` when the tool's *useful* output has a natural ceiling. Do not declare it when the right answer is "as much as fits". `terminal` does not declare one — a command might produce a large diff that the model genuinely needs to see in full.

### What "truncated" means at the contract level

The truncation marker is intentionally specific:

```
[truncated — 45,231 chars total]
```

The original length is part of the marker. A tool that produced 45k characters in a 26k budget tells the model what was lost. The model can react: "the file is 45k, read a specific region rather than the whole thing"; "the search returned more than I budgeted for, narrow the query"; "the terminal output ran long, pipe it through `head -200` next time".

The marker is not a structured field. It is plain text appended to the truncated string. The reason: the model is the consumer, and the model reads strings. A structured `truncated: true` field would be invisible to the next prompt. The plain-text marker is part of the prompt by construction.

### The budget is per-turn, not per-iteration

A turn can have multiple LLM iterations — the model calls a tool, sees the result, calls another tool, sees that result, then composes a reply. The 80k budget applies to *each* `executeParallel` invocation, not to the whole turn.

If the model calls three tools in iteration 1 (80k split three ways), then two tools in iteration 2 (80k split two ways), the turn consumed 80k + 80k = 160k characters of tool output across two iterations. The cap is per-batch, not per-turn.

The reasoning: a multi-iteration turn is the model deliberately deciding to ask another question after seeing a result. Each iteration's `executeParallel` is a fresh budget because each iteration represents new information demand. The total per-turn cost is bounded by `maxToolCallsPerTurn` (default 1000) and `maxIdenticalToolCalls` (default 25), which exist for the same reason — runaway tool loops.

### `executeParallel` does the work that callers used to coordinate

Before the budget existed, every tool author re-implemented the same truncation logic: read N bytes, slap on a marker, return. Some tools forgot. Some used different markers. Some truncated by line count, some by byte count, some by token count. The model saw inconsistent contracts and learned to ignore truncation markers because they meant different things from different tools.

Centralising the trim in `executeParallel` is the fix. Tools return raw strings; the registry applies the same trim and the same marker shape. The model sees one contract: `[truncated — N chars total]`. Tools become simpler — `read_file` does not need to know how big the budget is; it reads whatever the user asked for and returns it.

The tool *can* trim internally if it knows something the framework does not. A `web_extract` that fetches a 5MB HTML page might prefer to do its own truncation (keeping the article body, dropping the navigation chrome) rather than have `executeParallel` slice the raw HTML at 80k. The `maxResultChars` declaration is the seam: declare a tight cap, do your own smart trimming, and the framework leaves your result alone (provided it stays under your declared cap).

### Why pre-trim hasn't replaced post-trim

Pre-trim would mean: pass the per-call budget into `execute` and have the tool produce no more than that. Cleaner in theory; broken in practice.

Many tools cannot pre-trim usefully. A `terminal` running `make build` produces output as the command runs — it does not know in advance whether the output will be 100 lines or 100k lines. A `web_extract` does not know the page size before fetching. A `delegate_task` does not know the sub-agent's reply length until the sub-agent emits `done`.

Post-trim catches the problem at a single point: the registry sees the final string, applies the cap, emits the marker. The tool's `execute` stays simple — produce the best result you can, return it, trust the framework to bound it. Tools that *can* pre-trim (because their output is structured) declare `maxResultChars` and limit themselves; the framework's post-trim becomes a safety net for the cases where they do not.

### The `tool_progress` event is not part of the budget

Tools emit progress via `ctx.emit({ type: 'progress', toolName, message })`. Progress is a streaming event, consumed by surfaces — not stored as part of the final `tool_result`. It does not count against the budget.

This is the right shape because progress is per-event-stream, not per-result. A long-running `bash` command emits twenty progress chips during execution; the final `tool_result` is one bounded string. The chips inform the user (or stay internal) without inflating the LLM's context.

See [Why does tool progress have an audience field?](audience-boundary.md) for the orthogonal question of *which* progress events render where.

### Budget interacts with the per-turn tool-call cap

Two separate caps work together. `resultBudgetChars` bounds the *size* of tool output; `maxToolCallsPerTurn` (default 1000) bounds the *count* across all LLM iterations in one user turn. A turn that calls 1000 tools is the upper bound of iteration, not "1000 tools per iteration".

The reasons for both caps:

- A turn with a single 80k tool output and one iteration is fine; total tool output is 80k.
- A turn with 1000 sequential single-tool iterations is fine; each gets a fresh 80k budget; total is 80MB across the turn.
- A turn with 1001 sequential single-tool iterations trips `maxToolCallsPerTurn`. The framework exits cleanly with a user-visible `tool_progress` warning. This is the "runaway tool loop" failure mode: a model that keeps reading slightly different files and never converges. The cap catches it.

The two caps are also independent of `maxIdenticalToolCalls` (default 25) — the same tool name invoked more than 25 times in one turn trips a separate guard. The CLAUDE.md note frames this as the "tts loop reported as OpenClaw #67744" failure mode: a tool that the model keeps re-invoking because each call looks slightly different. The identical-tool cap catches it before the per-turn cap does.

### The budget is also visible to tools via `ToolContext`

Each tool's `execute(args, ctx)` receives `ctx.resultBudgetChars` — the per-call budget the registry computed for this invocation. Tools that *want* to pre-trim can read it and produce output that fits. Most tools ignore it; the post-trim catches them. Tools that pre-trim sensibly (a `read_file` that pages on byte ranges, a `web_search` that limits result count) read the budget and respect it.

This is the seam for tools that have semantic knowledge of "what to keep when trimming". A raw `slice(0, budget)` cuts mid-word, mid-line, mid-JSON. A tool that knows its output structure can trim at a meaningful boundary — drop the last paragraph rather than mid-sentence; keep the article body, drop the navigation. The framework's post-trim is the safety net; pre-trim is the quality option.

The contract: if a tool's pre-trim brings the output under the budget, the framework leaves it alone. If the tool ignores the budget or produces output that still exceeds it, the post-trim runs.

### When to override `resultBudgetChars`

The default of 80k fits Claude's main context window. Reasons to override via `AgentLoopConfig.options.resultBudgetChars`:

- A smaller-window model (an OpenAI-compat 16k-context model). Drop to 6–10k or your prompt does not fit.
- A larger-window model with cheap input tokens (a 1M-context Claude variant). Raise to 200k if your turns genuinely use it; most don't.
- A workflow that runs ten parallel reads of small files. Raise the budget if the post-trim is biting on calls that produce 10k each.
- A research workflow that fetches a single long document. Raise the budget if a single call routinely truncates at 80k and the model is making poor decisions on the truncated remainder.

The override is one constructor argument. Most deployments leave the default alone.

## Trade-offs

**The split is even, not weighted.** Three parallel calls each get 26k regardless of which tool they are. A `read_file` and a `web_search` and a `terminal` all share equally. If one of them needed 60k and the other two needed 5k, the budget is wasted on the small ones and the large one truncates. The mitigation is `maxResultChars` — declare 10k on small-output tools and the big one gets the slack. The framework's split picks fairness over global optimality.

**Per-call splitting can punish parallelism.** Four parallel reads of 30k files each — every result truncates at 20k. The model sees four `[truncated]` markers and may not know which file matters most. The sequential-read alternative (three iterations of one tool each) gets full budget per call but pays three turn latencies. The trade is real; choose based on whether truncation or latency is the worse failure for your workflow.

**The truncation marker is plain text, not metadata.** The model sees `[truncated — N chars total]` as part of the string. A future LLM that parses structured metadata better than text would prefer a `truncated` field on the message envelope. The current contract reflects the current model behaviour: the marker is read because it sits inline.

**You cannot have a "soft" budget that asks the model to be polite.** The post-trim is unconditional. A tool that returns 100k characters in a 26k slot loses 74k characters with no signal beyond the marker. The framework does not negotiate with the tool. The reason: negotiation produces inconsistent budget enforcement across tools, and the model learns to game it. Hard cap, visible marker, no exceptions.

Alternatives considered:

- A per-tool fixed cap (every tool declares `maxResultChars`, no global budget). Rejected: a single-tool turn is shortchanged; the global budget gives the right shape for "one big read".
- A token-counting budget instead of character count. Rejected for v1: tokenisation is provider-specific, expensive to compute on every result, and "characters" is a tight enough approximation for the dominant case. Likely to evolve.
- Asking the model to produce a "request budget" alongside each tool call. Rejected: introduces a meta-protocol the model must learn before it can use a tool, and the model's estimates would be unreliable.
- Streaming tool output (chunks of `tool_result`). Rejected: not supported by the Anthropic message contract today; a single `tool_use` block expects a single `tool_result` block.

## See also

- [Why does AgentLoop receive every dependency at construction?](injection-at-construction.md) — how `resultBudgetChars` flows in via config
- [Why does tool progress have an audience field?](audience-boundary.md) — the orthogonal question of progress rendering
- [Tool interface reference](../reference/tool-interface.md) — every field on `Tool`, including `maxResultChars` and `outputIsUntrusted`
- [ToolRegistry reference](../reference/tool-registry.md) — `executeParallel` mechanics
- [Architecture in 90 seconds](../../getting-started/architecture-90-seconds.md) — where `executeParallel` sits in the turn cycle
