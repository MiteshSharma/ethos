---
title: "Build on Ethos in ten minutes"
description: "Clone the monorepo, install with pnpm, run pnpm check, write a 20-line tool, and see the agent call it in chat — start to finish in ten minutes."
kind: tutorial
audience: developer
slug: quickstart
time: "10 min"
updated: 2026-05-12
---

This page is for contributors and plugin authors. The shortest path from a fresh clone to a custom [tool](../getting-started/glossary.md#tool) the agent calls in chat. End-user setup lives in the [Using Ethos quickstart](../using/quickstart.md); skip that — you build against source here, not against the published CLI.

## Goal

By the end, you have:

- The `ethos` monorepo cloned with all workspace packages installed via pnpm.
- `pnpm check` (typecheck + lint + test) passing on the main branch.
- `pnpm dev` running an interactive chat off your local tree — no build step.
- A 20-line `say_hi` tool in `extensions/tools-file/src/` that the agent calls when you ask it to.
- A working dev loop: edit `.ts`, send a chat message, see the change in the next [turn](../getting-started/glossary.md#turn).

The point is the dev loop, not the tool. By minute ten, you can sketch any tool you like with the same shape.

## Prereqs

- Node 24 or newer. Check with `node --version`. The repo pins via `.nvmrc`; `make setup` installs it if you use nvm.
- pnpm 10. `corepack enable` works, or `npm install -g pnpm@10`. The repo pins `packageManager` in the root `package.json`.
- Git, plus a checkout of `https://github.com/ethosagent/ethos`.
- An Anthropic API key in the shell (`export ANTHROPIC_API_KEY=sk-ant-...`). OpenAI / OpenRouter / Ollama work via the OpenAI-compat provider, but Anthropic is the path of least resistance — Claude is the default model.
- A terminal you can run two panes in (one for `pnpm dev`, one for `pnpm test`).

## 1. Clone and install

```bash
git clone https://github.com/ethosagent/ethos.git
cd ethos
make prepare
```

`make prepare` runs `pnpm install --frozen-lockfile` and installs the git hooks via lefthook. It is idempotent — re-run it any time you switch branches.

If the install fails, the most common cause is a Node version mismatch (`pnpm` ignored the `.nvmrc`). Run `nvm use` first, then `make prepare` again.

When it finishes, you should see five workspace packages and dozens of extensions resolved:

```bash
pnpm list --depth -1 | head -20
```

The interesting roots: `packages/types` (zero-dep interfaces), `packages/core` (`AgentLoop`, `ToolRegistry`, `HookRegistry`), `apps/ethos` (CLI entry), and the `extensions/*` tree.

## 2. Run the full check before you change anything

```bash
pnpm check
```

That runs `pnpm typecheck && pnpm lint && pnpm test` — exactly what CI runs on every pull request. Vitest will exercise ~3000 tests across the workspace; expect 30-60 seconds on a recent laptop.

A clean `pnpm check` on `main` is the baseline. Any failure here is a repo-side issue, not your code — open an issue with the failing line.

You can also run pieces in isolation:

```bash
pnpm typecheck                                      # tsc --noEmit
pnpm lint                                           # biome check .
pnpm test                                           # vitest run
pnpm --filter @ethosagent/core test                 # one package only
pnpm --filter @ethosagent/core test --watch         # watch mode for one package
```

The watch-mode workflow is the one you actually want once you start editing. Vitest is fast enough that "save the file, see the assertion fail or pass" is the right inner loop.

## 3. Start a chat against your local tree

```bash
pnpm dev
```

`dev` is `tsx apps/ethos/src/index.ts` — Node 24 executes the TypeScript source directly through tsx. No `dist/`, no build step, no watch process. Every `import` resolves against `./src/*` via the workspace `exports` and root `tsconfig` path aliases, so any edit you make is live on the next process start.

First run prompts for an LLM provider and key. Pick `anthropic`, paste the key, accept the defaults — `~/.ethos/config.yaml` is written automatically.

Once the chat opens, send a probe:

```
You > list the tools you can call. one per line, with one phrase per tool.
```

The reply enumerates the built-in toolset: `read_file`, `write_file`, `web_search`, `bash`, `memory_read`, `memory_write`, and friends. These are the tools you are about to join.

Press `Ctrl+C` to exit, or leave the chat running in a second pane — you will come back to it after you write the tool.

## 4. Add a tool to the file toolset

The fastest place to add a tool is alongside an existing extension. Open `extensions/tools-file/src/index.ts` — it already imports `Tool`, `ToolResult`, and `ToolContext` from `@ethosagent/types`. Add this at the bottom of the file:

```typescript
import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';

export const sayHiTool: Tool<{ name: string }> = {
  name: 'say_hi',
  description: 'Greet a person by name. Use when the user wants a friendly greeting.',
  toolset: 'file',
  maxResultChars: 200,
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The person to greet' },
    },
    required: ['name'],
  },
  async execute(args, _ctx): Promise<ToolResult> {
    const { name } = args;
    if (!name || typeof name !== 'string') {
      return { ok: false, error: 'name is required', code: 'input_invalid' };
    }
    return { ok: true, value: `Hi, ${name}! Glad to meet you.` };
  },
};
```

Three things to notice:

- **`schema` is JSON Schema, not Zod.** That shape is what the LLM sees — every property and `required` entry is documentation for the model.
- **`execute` returns `ToolResult`.** Either `{ ok: true, value: string }` or `{ ok: false, error, code }`. The `value` string is appended verbatim to the LLM's next turn input.
- **`maxResultChars` caps the per-call output.** The framework's default per-turn budget is 80,000 chars split across concurrent calls; a tool can declare a tighter cap when its outputs are small by definition. See the [Tool interface reference](./reference/tool-interface.md) for the full contract.

## 5. Export it and wire it in

`extensions/tools-file/src/index.ts` exports a `createFileTools()` factory. Find it (it returns an array of tools) and append `sayHiTool` to the returned array:

```typescript
export function createFileTools(): Tool[] {
  return [
    readFileTool,
    writeFileTool,
    patchFileTool,
    searchFilesTool,
    sayHiTool, // <-- add this line
  ];
}
```

`createFileTools()` is called from `packages/wiring/src/index.ts` inside `createAgentLoop`. The registry registration happens there in one line:

```typescript
for (const tool of createFileTools()) tools.register(tool);
```

No additional wiring step. The tool joins the registry on the next `pnpm dev` boot.

## 6. Add the tool to a personality's allowlist

The [ToolRegistry](../getting-started/glossary.md#tool-registry) filters the LLM-visible catalog by the active [personality's](../getting-started/glossary.md#personality) `toolset.yaml`. If a tool is not in that file, the LLM never sees it. The active personality on first install is `engineer` — check its bundled toolset:

```bash
cat extensions/personalities/data/engineer/toolset.yaml
```

`read_file`, `write_file`, and friends are listed. To get `say_hi` in front of the model, either edit this file (risks committing test edits) or override the personality from `~/.ethos/personalities/engineer/toolset.yaml` — user files win over bundled ones on the same id.

The fast path is the second:

```bash
mkdir -p ~/.ethos/personalities/engineer
cp extensions/personalities/data/engineer/toolset.yaml ~/.ethos/personalities/engineer/
echo "- say_hi" >> ~/.ethos/personalities/engineer/toolset.yaml
```

The registry hot-reloads on file mtime — the change picks up on the next [turn](../getting-started/glossary.md#turn) without restarting `pnpm dev`.

## 7. See the tool execute

Restart `pnpm dev` (so the new export lands in the running process) and send:

```
You > use the say_hi tool to greet ada lovelace.
```

The chat surface streams the events as they happen:

```
[tool_start  ] say_hi { name: "Ada Lovelace" }
[tool_end    ] say_hi · ok · 1ms
Hi, Ada Lovelace! Glad to meet you.
```

The `[tool_start]` and `[tool_end]` lines come from the `AgentLoop`'s `AsyncGenerator<AgentEvent>` stream. The final text is the model's response after it saw the tool result. Total round-trip: two LLM calls (one to pick the tool, one to write the reply) plus your 1ms `execute`.

If the agent refuses or picks a different tool, the most common cause is that `say_hi` is missing from the active personality's `toolset.yaml`. Verify:

```
You > list the tools you can call.
```

If `say_hi` is not in the list, the toolset file is the problem. If it is in the list but the agent does not call it, the `description` is not compelling enough — sharpen the prose so the model picks it.

## 8. Add a test for the tool

Tools are pure functions in this codebase — easy to test. Create `extensions/tools-file/src/__tests__/say-hi.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '@ethosagent/types';
import { sayHiTool } from '..';

const ctx: ToolContext = {
  sessionId: 't',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: process.cwd(),
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 80_000,
};

describe('sayHiTool', () => {
  it('greets the named person', async () => {
    const result = await sayHiTool.execute({ name: 'Ada' }, ctx);
    expect(result).toEqual({ ok: true, value: 'Hi, Ada! Glad to meet you.' });
  });

  it('rejects missing name', async () => {
    const result = await sayHiTool.execute({ name: '' }, ctx);
    expect(result).toMatchObject({ ok: false, code: 'input_invalid' });
  });
});
```

Run it:

```bash
pnpm --filter @ethosagent/tools-file test
```

Both assertions pass. The framework never gets involved in this test — you exercise the `execute` function directly with a stub `ToolContext`. That is the model for every tool test in the repo: read `extensions/tools-file/src/__tests__/` for the production examples.

## 9. Run the full check before you commit

Before pushing, run the same command CI runs:

```bash
pnpm check
```

That covers typecheck, lint, and tests. If `pnpm lint` reports fixable issues, `pnpm lint:fix` rewrites them in place; re-run `pnpm check` to confirm clean.

The same script is wrapped by `make check`. Use whichever you prefer; CI invokes the scripts directly via `scripts/run-checks.sh`.

## What you learned

- The repo is a pnpm workspace; `make prepare` installs dependencies and sets up git hooks.
- `pnpm dev` runs `tsx apps/ethos/src/index.ts` — no build step, edits are live on next process start.
- `pnpm check` runs typecheck + lint + tests; the same script is what CI runs.
- A tool is an object implementing `Tool<TArgs>` from `@ethosagent/types`: `name`, `description`, `schema`, `execute`, optional `maxResultChars` and `isAvailable`.
- The `ToolRegistry` filters the LLM-visible toolset by the active personality's `toolset.yaml`; user files at `~/.ethos/personalities/<id>/` override the bundled defaults.
- Tools are unit-testable in isolation — pass a stub `ToolContext` and assert on the returned `ToolResult`.

## Next step

You wrote a tool that lives inside the monorepo. Next, learn the full tool contract — `ToolResult` codes, `maxResultChars` budgeting, `isAvailable` gating, the audience boundary on progress events — then ship a real tool through the same loop.

- [Write your first tool](./tutorials/write-your-first-tool.md) — the long-form version of step 4-7 with the production contract.
- [Add an LLM provider](./tutorials/add-an-llm-provider.md) — drop in a custom model by implementing `LLMProvider`.
- [Add a channel adapter](./tutorials/add-a-channel-adapter.md) — bridge a new messaging platform without re-implementing dedup.
- [Tool interface reference](./reference/tool-interface.md) — every field on `Tool<TArgs>` and `ToolContext`.
