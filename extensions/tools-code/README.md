# @ethosagent/tools-code

Tools for executing untrusted code in a Docker sandbox and for running the host project's tests and linter.

## Why this exists

The agent often needs to run a quick script (Python, Node, bash) without touching the host. `run_code` delegates to `@ethosagent/sandbox-docker`, which executes inside an isolated container with no network and 256 MB memory. `run_tests` and `lint` are the everyday host-side commands an agent uses to verify its own changes — they are intentionally unsandboxed because they need to see the project on disk.

## Tools provided

| Tool name | Toolset | Purpose |
|---|---|---|
| `run_code` | `code` | Execute a snippet in an isolated container (`python`, `js`, or `bash` runtime). |
| `run_tests` | `code` | Run the project test suite (default `pnpm test`). |
| `lint` | `code` | Run the project linter (default `pnpm lint`). |

Factory: `createCodeTools(sandbox: DockerSandbox)`.

## How it works

Runtimes are a static table at `src/index.ts:14`:

| Runtime | Image | Entry |
|---|---|---|
| `python` | `python:3.12-slim` | `python3 -` |
| `js` | `node:22-slim` | `node --input-type=module` |
| `bash` | `bash:5.2` | `bash -s` |

`run_code` pipes the user code into the container via stdin (`sandbox.run(image, cmd, { stdin, timeoutMs })`). It is gated by `sandbox.isAvailable()` — when Docker is missing the tool reports `code: 'not_available'` and `isAvailable()` hides it from the personality's toolset. Default timeout 30 s; `maxResultChars: 10_000`.

`run_tests` and `lint` shell out via `node:child_process.exec` against `ctx.workingDir` (overridable). `run_tests` allows 120 s and a 10 MB buffer; `lint` allows 60 s and a 5 MB buffer. Like the `terminal` tool in `@ethosagent/tools-terminal`, they return non-zero exits as `ok: false` with stdout/stderr captured in the error message — the LLM sees the failing test or lint output verbatim.

Both host-side tools default their command (`pnpm test`, `pnpm lint`) but accept an override `command` arg, so projects on a different runner can route through the same tool.

## Gotchas

- `run_code` requires Docker on the host. There is no in-process fallback. Pulling the runtime images on first use is the responsibility of `@ethosagent/sandbox-docker`.
- `run_tests` and `lint` are NOT sandboxed. They execute with the agent's full host privileges. Do not expose them to a personality you would not trust to run arbitrary `terminal` commands.
- `run_code` accepts a `timeout_ms` arg with no maximum — the only ceiling is whatever `DockerSandbox` enforces. Be aware when wiring.
- The `js` runtime uses `--input-type=module`, so CommonJS `require(...)` snippets fail.
- `run_tests` 120 s timeout will kill long suites. Override `command` to a focused subset (e.g. a single vitest file) for slow projects.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Runtime table, `run_code`, `run_tests`, `lint`, and the `createCodeTools(sandbox)` factory. |
| `src/__tests__/` | Tests for runtime dispatch, timeout handling, and exec error capture. |
