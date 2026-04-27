# @ethosagent/sandbox-docker

Runs commands inside ephemeral Docker containers with capabilities dropped, network disabled by default, and memory capped — the isolation primitive used by tools that execute untrusted code.

## Why this exists

Some tools (`bash`, code interpreters, build runners) need to execute arbitrary input. Running them on the host risks the agent damaging the developer's machine or exfiltrating data. `DockerSandbox` is the smallest possible wrapper around `docker run --rm` that gives those tools a contained execution environment without pulling in any orchestration framework.

The package depends only on `@ethosagent/types` and Node's `child_process`. No SDK, no daemon connection — just `spawn`.

## What it provides

- `DockerSandbox` — `init()`, `isAvailable()`, `run(image, cmd, opts?)`, `cleanup()`.
- `ExecResult` — `{ stdout, stderr, exitCode }`.
- `RunOptions` — `{ stdin?, timeoutMs?, env?, networkMode?, memoryMb? }`.

## How it works

**Availability probe.** `init()` spawns `docker info` with a 5 s timeout. If exit code is 0, `_available = true`. Tools should call `init()` once at wiring time and gate on `isAvailable()` — when Docker is missing, `run()` returns `{ stdout: '', stderr: 'Docker not available', exitCode: 1 }` rather than throwing (`src/index.ts:42`).

**Container hardening.** Every `run()` call assembles `docker run --rm` with these defaults applied unconditionally:

- `--network none` (overridable to `bridge`) — no outbound traffic by default.
- `--memory=<N>m` and `--memory-swap=<N>m` set equal to disable swap entirely (`src/index.ts:51`). Default 256 MB.
- `--cap-drop ALL` — every Linux capability stripped.
- `--security-opt no-new-privileges` — blocks setuid escalation.
- `-i` only when stdin is supplied.
- Each `env` entry is passed as `-e`.

The container image and command are caller-controlled and untrusted-input by design — the hardening flags are what makes that safe.

**Lifecycle.** Containers are ephemeral (`--rm`) so `cleanup()` is a no-op. `spawnRaw()` arms a kill timer (`SIGKILL` after `timeoutMs`, default 30 s, `src/index.ts:89`), pipes stdout/stderr into Buffer arrays, and resolves with the concatenated output. A timeout rejects the Promise; a spawn error rejects too. Callers should `try`/`catch` for both.

## Configuration

Docker must be installed and the daemon running. There are no env vars. Image pulls are not handled here — pre-pull images you intend to run, or accept the latency of the first call (Docker handles the implicit pull).

The default network mode is `'none'`. Switch to `'bridge'` only when the tool genuinely needs network access (e.g. `pip install`); leaving it on widens the trust boundary considerably.

## Gotchas

- `init()` must be called before `isAvailable()` returns the right value. Skip `init()` and `isAvailable()` returns `false` even when Docker is fine.
- Timeouts use `SIGKILL`, not `SIGTERM` — the container won't get a chance to clean up. With `--rm`, this is acceptable.
- `--memory-swap` set equal to `--memory` disables swap. If you raise one, raise both, or you accidentally re-enable swap.
- The default 256 MB memory cap is small. Build / compile workloads frequently OOM at this size — bump `memoryMb` for them.
- The default 30 s timeout is also tight. Long-running scripts should pass an explicit `timeoutMs`.
- `env` entries are passed as raw strings (`KEY=value`). The function does no validation; a malformed entry is a Docker error at run time.
- There is no image allowlist. The caller is responsible for choosing a trusted image — this layer trusts whatever you pass.
- `child.stdin.write(stdin)` happens before `child.stdin.end()` regardless of whether `-i` was added. With no `-i`, the write is harmless (the container has no stdin to read), but the code path runs.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `DockerSandbox` class, `RunOptions`, `ExecResult`. |
