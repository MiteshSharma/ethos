# Custom Context Engine Template

A starter template for building custom context engines in the Ethos agent
framework. Context engines control how conversation history is compacted when
it approaches the model's token budget.

## Quick start

1. Copy the `templates/context-engine/` directory into your workspace.
2. Rename the package in `package.json` (replace `YOURNAME`).
3. Rename `CustomContextEngine` and set the `name` property to your engine's
   unique identifier.
4. Implement your compaction strategy in the `compact()` method.
5. Install dependencies: `pnpm install`.
6. Run the tests: `pnpm vitest run`.

## The ContextEngine interface

Every context engine implements up to four members from `@ethosagent/types` --
two required (`name`, `compact`) and two optional (`shouldCompact`,
`onTurnComplete`):

### `name: string` (required)

A unique identifier for your engine. This is the string personality authors
reference in their config: `context_engine: my_engine_name`.

### `compact(opts: ContextEngineCompactInput): Promise<ContextEngineCompactOutput>` (required)

Called when the framework decides compaction is needed. Receives the full
message history, system prompt, target token budget, and optional helper
handles. Must return a shorter (or equal-length) message history that fits
within the budget.

The output object supports optional fields for audit and caching:

- `messages` -- the compacted message array (required).
- `notes` -- a human-readable string describing what happened (required).
- `summaryText` -- the generated summary, if any.
- `removed` -- an array of `{ index, reason }` entries for evicted messages.
- `summaries` -- an array of `{ text, sourceRange }` for generated summaries.
- `externalWrites` -- keys written to the external store.
- `cacheBreakpoints` -- message indices where the provider should place cache
  breakpoints.

### `shouldCompact(input: ContextEngineCompactInput): boolean` (optional, NOT WIRED)

**The framework does not call this today.** `maybeCompact` decides purely on its
own pressure gate, so an engine that declares `shouldCompact` gets no extra
trigger. The method is declared, conformance-tested and reserved for a future
call site; the shape is stable, but do not design behaviour around it yet.

### `onTurnComplete(input): Promise<ContextEngineTurnCompleteOutput | null>` (optional, wired)

Called at the end of **every** turn -- after the `done` event while the session
lane is still held, and before the framework's turn-end auto-compaction and
memory-flush gates. It fires even when both of those are disabled.

This is the amortization seam. Instead of one long compaction stall when the
pressure gate finally trips, nominate a small slice of stale tool results each
turn:

```ts
return { trimToolResults: [...], clearToolResults: [...], notes: '...' };
```

The framework applies nominations as **content-only** rewrites of the matching
`tool_result` blocks -- it never removes or reorders a message, so a
`tool_use` / `tool_result` pair can never be split. Return `null` to leave the
framework's own default schedule in charge.

Four rules, each of which protects the prompt cache:

1. **Nominate `tool_use` ids, never array indices.** The message array grows
   every turn; an index-keyed nomination drifts onto a different message.
2. **Be deterministic.** The same input must produce the same nominations, so a
   turn with no state change rewrites the view byte-identically.
3. **Only ever add.** The framework unions nominations into a persisted
   monotonic state and never un-ages an id.
4. **Never nominate an id absent from `input.messages`.**

`input` carries `messages`, `currentSystem`, `pressureRatio` (estimated usage as
a fraction of the model window), `personality`, `sessionMetadata`, and an
optional `store` handle for engine-owned bookkeeping between turns.

## Available handles in `ContextEngineCompactInput`

The `opts` argument to `compact()` provides several optional helper handles:

- `opts.llm.summarize(messages, targetTokens)` -- ask the LLM to summarize a
  slice of the conversation.
- `opts.store.write(key, value)` / `opts.store.read(key)` -- page data out to
  an external store for later recall.
- `opts.countTokens(text)` -- model-accurate token count (when available; fall
  back to the `estimateTokens` heuristic otherwise).
- `opts.embed(texts)` -- generate embeddings for semantic similarity.
- `opts.score(a, b)` -- score relevance between two text spans.

All handles are optional. Check for their presence before calling.

## Registering your engine

In your plugin's `setup()` function:

```ts
import { MyEngine } from './my-engine';

export const myPlugin = {
  name: 'my-plugin',
  setup(api) {
    api.registerContextEngine(new MyEngine());
  },
};
```

## Selecting in a personality

In the personality's `config.yaml`:

```yaml
context_engine: my_engine_name
```

The `context_engine` value must match the `name` property of your engine class.

## Testing with the conformance harness

The framework provides `validateContextEngine` from `@ethosagent/core`. It
exercises your engine against several scenarios and validates the output shape:

- **Under-budget** -- 2 short messages with a high token target.
- **Over-budget** -- 20 large messages with a low token target.
- **With handles** -- mock LLM, store, and countTokens injected.
- **Standing instructions** -- a durable user directive ("always answer in
  French") sits in the compactable middle. An engine that produces a
  `summaryText` must either carry the directive forward verbatim or cover it
  under a "Standing instructions" heading in the summary. This template does the
  former; see step 3 of `compact()`.
- **shouldCompact** -- if implemented, must return a boolean.
- **onTurnComplete** -- if implemented, must resolve to an object or `null`,
  nominate only `tool_use` ids present in the input, and be deterministic.
- **Output shape** -- messages array, notes string, valid roles, non-empty
  content, cacheBreakpoints in range, removed entries valid, summaries valid,
  externalWrites valid.

Use it in your tests:

```ts
import { validateContextEngine } from '@ethosagent/core';
import { MyEngine } from './my-engine';

const result = await validateContextEngine(new MyEngine());
expect(result.passed).toBe(true);
```

See `src/index.test.ts` in this template for a complete working example.
