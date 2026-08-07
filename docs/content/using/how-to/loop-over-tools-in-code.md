---
title: Loop over tools in code
description: Use the in-script tool API — ethos.call inside run_code — to fan out many tool calls in one sandboxed script and return only the final result.
kind: how-to
audience: user
slug: loop-over-tools-in-code
time: 10 min
updated: 2026-08-07
---

A turn that reads forty files, filters them, and counts matches pays forty tool results into the conversation. A script that does the same loop pays one: the intermediate results go to the script, and only what it prints re-enters the conversation.

## Task

Have the agent run a multi-call workflow inside one `run_code` script using `ethos.call(name, args)`, instead of issuing the tool calls directly.

## Result

One `run_code` call replaces N direct tool calls. The script loops, filters, and aggregates in code; only its final `print()` output (capped at 10,000 characters) enters the conversation history.

## Prereqs

- A [personality](../../getting-started/glossary.md#personality) (the directory of files that decides the agent's tools, memory, and model) whose `toolset.yaml` includes `run_code`.
- A working Docker execution backend — `run_code` never executes on the host. See [Run in Docker](run-in-docker.md).

## 1. Confirm the personality has a script surface

The script-callable surface is a derivation, not a setting: `toolset ∩ SCRIPT_SAFE`. There is nothing to configure — the personality's existing toolset allowlist is the policy, enforced a second time at the script boundary. Check what a personality exposes:

```bash
ethos personality show <personality-id>
```

The Toolset section carries one extra line when `run_code` is present:

```
## Toolset
5 tools:
- read_file
- write_file
- web_search
- memory_read
- run_code
- Script-callable (run_code): 4 of 5 tools (excluded: code, delegation, MCP, plugins, clarify, credential-bearing terminal/debug)
```

A personality without `run_code` in its toolset has no script surface at all. The excluded categories are fixed in [packages/core/src/script-safe.ts](https://github.com/ethosagent/ethos/blob/main/packages/core/src/script-safe.ts):

| Excluded | Why |
|---|---|
| `code` toolset (`run_code`, `run_tests`, `lint`) | Recursion guard — a script cannot start a script. |
| Delegation tools (`delegate_task`, `dispatch_team`, …) | Spawning agents from a script has no depth ledger; unbounded fan-out. |
| MCP tools (`mcp__*`) | Third-party schemas behind a separate allowlist mechanism; excluded at v1. |
| Plugin tools | The plugin contract does not promise reentrancy from a non-LLM caller. |
| `clarify` | A script waiting on a human is a hung container. |
| `terminal` and `debug` toolsets | Their results can carry credential material (host environment, raw session transcripts) — never handed to sandboxed code. |

## 2. Ask for the pattern — or write the script yourself

The agent self-selects the pattern from the `run_code` tool description: prefer one script over direct calls for workflows of **3+ tool calls with processing logic between them**. For 1–2 calls, direct tool calls stay the right shape — the script adds container latency for no context savings.

The API inside the sandbox is one function. Python (`import ethos` first):

```python
import ethos, json

total = 0
for path in ["a.md", "b.md", "c.md", "d.md"]:
    res = ethos.call("read_file", {"path": path})
    if res["ok"] and "TODO" in res["value"]:
        total += 1
print(f"{total} files contain TODO")
```

JavaScript (`ethos` is a global; runtime `js`):

```js
const res = await ethos.call('web_search', { query: 'ethos agent framework' });
console.log(res.ok ? res.value.slice(0, 200) : `failed: ${res.error}`);
```

Every call returns a plain object, never throws:

| Field | Type | Meaning |
|---|---|---|
| `ok` | boolean | Whether the call succeeded. |
| `value` | string | The tool result when `ok` is true. |
| `error` | string | Failure reason when `ok` is false — the same text a direct LLM call would get. |
| `code` | string | Machine-readable failure code, e.g. `not_available`, `tool_blocked`, `per_execution_cap`. |

`bash` scripts have no tool API at v1 — only `python` and `js` runtimes are framed.

## 3. Know the budgets

| Bound | Value | What happens at the limit |
|---|---|---|
| Tool calls per execution | 50 | Call 51 returns `{ok: false, code: "per_execution_cap"}`. The script can still print and exit — the cap fails the call, not the container. |
| Wall clock | `timeout_ms`, raised to a 300,000 ms ceiling for scripts that use the tool API | The container is killed at the deadline. |
| Per-call result to the script | 262,144 chars (or the tool's own `maxResultChars`, whichever is lower) | Larger results are trimmed with a `[truncated]` marker. |
| Script output re-entering the conversation | 10,000 chars | `run_code`'s result is trimmed like any tool result. Print summaries, not dumps. |

Turn-level budgets still apply on top: a script that makes 60 calls has made 60 calls against the per-turn tool budget, and safety watcher rules count inner calls exactly like direct ones.

## Verify

Run a chat turn that fans out. In `ethos chat`, the whole script shows as **one** tool chip:

```
  ✓ run_code (python) 2.1s
ethos > 3 of 4 files contain TODO
```

The inner calls are not invisible — they emit real events tagged `audience: internal` (namespaced `<parent>#1`, `<parent>#2`, …), visible in `/verbose` mode and in logs. When a script crosses 10 inner calls you also get one progress line: `· run_code: running 10+ tool calls in code…`.

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| `NameError: name 'ethos' is not defined` / `ethos is not defined` | The tool API is not wired for this turn (no bridge), or the runtime is `bash`. | Use `python` or `js`; confirm the deployment runs a current build with the Docker backend up. |
| `Tool X is not permitted for this personality` | The tool is outside the personality's toolset — the same allowlist error a direct call gets. | Add the tool to `toolset.yaml`, or use a personality that has it. |
| `not script-callable (excluded category: …)` | The tool is in an excluded category from the table in step 1. | Call it directly from the conversation instead — exclusions are static policy, not configuration. |
| `{code: "per_execution_cap"}` after 50 calls | Per-execution cap. | Aggregate more work per call, or split across two `run_code` calls. |
| `Stopped: hit N-tool-call budget for this turn` | The shared turn budget tripped mid-script. | The turn halts after the script returns; raise `maxToolCallsPerTurn` only if the workload is legitimate. |
| Script dies mid-loop with a watcher reason | A safety watcher rule fired; the whole execution is aborted, not just the call. | Watcher halts are deliberate — review the rule before retrying. |

## See also

- [Set up approval gates](set-up-approval-gates.md) — `before_tool_call` hooks fire for in-script calls through the same path.
- [Run in Docker](run-in-docker.md) — the sandbox posture (`--network none`, empty environment) the script runs under.
- [Personality config reference](../reference/personality-yaml.md) — `toolset.yaml`, the single allowlist behind both enforcement points.
- [What is a personality?](../explanation/what-is-a-personality.md) — why the script surface is a personality derivation, not a config flag.
