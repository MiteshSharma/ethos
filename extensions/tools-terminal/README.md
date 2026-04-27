# @ethosagent/tools-terminal

Single shell-execution tool plus a `before_tool_call` hook that blocks obviously destructive commands.

## Why this exists

An agent needs a way to run arbitrary shell commands (build, test, git, file ops) but should refuse to run commands that can wipe a disk or a database without human review. This package gives you both: the `terminal` tool and a guard hook that registers against `before_tool_call` to short-circuit dangerous patterns.

## Tools provided

| Tool name | Toolset | Purpose |
|---|---|---|
| `terminal` | `terminal` | Run a shell command via `/bin/bash` and return combined stdout+stderr. |

Also exported:

- `checkCommand(command)` — pure function returning `{ dangerous: false }` or `{ dangerous: true; reason }`.
- `createTerminalGuardHook()` — returns a `before_tool_call` handler that blocks dangerous `terminal` invocations.
- `createTerminalTools()` — factory returning `[terminalTool]`.

## How it works

`terminal` runs commands through `node:child_process.exec` with `shell: '/bin/bash'`. Default timeout is 30 s, max 5 min, max output buffer 5 MB. See `src/index.ts:7`. The `cwd` arg overrides `ctx.workingDir`. On non-zero exit, the tool returns `ok: false` with the captured stdout/stderr in the error string — the LLM still sees command output even when the command failed.

`maxResultChars: 20_000` — output beyond that is trimmed by `executeParallel`.

The guard hook (`src/guard.ts`) is intended to be registered on `before_tool_call`. It only fires when `payload.toolName === 'terminal'`. If `checkCommand` flags the command, the hook returns `{ error: '...' }`, which `AgentLoop` translates into a rejection — the tool never runs and a `tool_result` with `is_error: true` is persisted to keep the Anthropic message contract intact (see root `CLAUDE.md`).

Patterns checked (`src/guard.ts:7`):

- `rm -rf` (or `-fr`) targeting `/`, `~`, or `~/`
- `dd of=/dev/sdX|nvmeX|...`
- `mkfs` and variants
- Output redirection to a block device (`> /dev/sdX`)
- Fork bombs (`:(){:|:&};:`)
- SQL `DROP DATABASE|TABLE|SCHEMA` and `TRUNCATE TABLE` (case-insensitive)

## Gotchas

- The guard is regex-based, not a real shell parser. Quoting tricks, base64 wrappers, or `eval` payloads will bypass it. Treat it as a guardrail, not a sandbox.
- `terminal` always uses `/bin/bash`. POSIX-only distros without bash will fail at exec time.
- `exec` (not `spawn`) is used, so the entire output must fit in the 5 MB buffer; commands that stream gigabytes will fail.
- The hook returns `null` for any tool other than `terminal`, so it is safe to register globally even when other tools are in play.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `terminalTool`, `createTerminalTools()`, re-exports from `guard.ts`. |
| `src/guard.ts` | `checkCommand` patterns and `createTerminalGuardHook()`. |
| `src/__tests__/` | Tests for execution, timeout, error capture, and guard patterns. |
