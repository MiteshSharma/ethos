---
title: Contributing
description: How to set up the Ethos development environment, add extensions, and run the test suite.
sidebar_position: 5
---

# Contributing

## Development setup

```bash
# 1. One-time machine setup (installs nvm, Node 24, pnpm)
make setup

# 2. Install workspace dependencies
make prepare

# 3. Start the CLI in development mode
make dev
```

`make dev` runs `tsx apps/ethos/src/index.ts` directly against source — no build step needed. First run auto-launches `ethos setup` if `~/.ethos/config.yaml` is missing.

## Quality commands

```bash
make test        # vitest run
make typecheck   # tsc --noEmit across the workspace
make lint        # biome check .
make format      # biome format --write .
make check       # typecheck + lint + test (full CI pass)
```

Always run `make check` before opening a PR.

## Coding conventions

### Extensionless imports

All imports omit the file extension:

```typescript
// ✅ correct
import { AgentLoop } from './agent-loop'

// ❌ wrong
import { AgentLoop } from './agent-loop.ts'
import { AgentLoop } from './agent-loop.js'
```

`tsx` handles resolution in dev. This is the one hard rule — `--experimental-strip-types` (Node 24 native) requires extensions, which is why we don't use it.

### No `console.log` in library code

Only CLI code (`apps/ethos/src/`) may use `console.log`. All packages in `packages/` and `extensions/` must be silent. Structured logging via Pino is planned for a future phase.

### Biome formatting

Run `biome check --write .` before committing. It auto-fixes import order, formatting, and safe lint issues. Configuration is in `biome.json` at the repo root.

Single quotes, 2-space indent, 100-character line width.

### Non-null assertions are blocked

`array[n]!` and `map.get(key)!` are blocked by the `noNonNullAssertion` Biome rule. Use safe alternatives:

```typescript
// ✅ safe default
const item = array[n] ?? fallback

// ✅ explicit guard
const val = map.get(key)
if (val) { /* use val */ }
```

## Adding an extension

### New LLM provider

1. Create `extensions/llm-<name>/src/index.ts` — implement `LLMProvider` from `@ethosagent/types`
2. Create `extensions/llm-<name>/package.json` with `@ethosagent/types: workspace:*`
3. Add a path alias in root `tsconfig.json`
4. Wire it in `apps/ethos/src/wiring.ts` under a new `config.provider` value

### New tool

Implement `Tool<TArgs>` from `@ethosagent/types`. Return `{ ok: true, value: string }` or `{ ok: false, error, code }` from `execute()`. Register with `DefaultToolRegistry`.

### New platform adapter

Implement `PlatformAdapter` from `@ethosagent/types`. Wire into the gateway in `apps/ethos/src/`. Follow the session key convention: `<platform>:<identifier>`.

## Running tests

```bash
make test              # run all tests once
make test -- --watch   # watch mode
```

Tests live next to source files: `src/foo.test.ts` alongside `src/foo.ts`. Use vitest. Integration tests that touch SQLite use real databases (no mocks — past experience showed mock/prod divergence masks real bugs).
