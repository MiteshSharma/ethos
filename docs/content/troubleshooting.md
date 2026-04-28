---
sidebar_position: 11
title: Troubleshooting
---

# Troubleshooting

Common issues and how to fix them.

## CLI won't start

**Error: `command not found: ethos`**

The CLI isn't on your `PATH`. If you installed via `npm install -g`, open a new terminal — your shell may not have picked up the new binary yet. If you used `nvm`, ensure you're on Node 24:

```bash
nvm use 24
ethos --version
```

If it's still missing, reinstall:

```bash
npm install -g @ethosagent/cli
```

**Error: `config.yaml not found`**

The setup wizard didn't complete. Delete `~/.ethos/` and re-run setup:

```bash
rm -rf ~/.ethos
ethos setup
```

## API errors

**`AuthenticationError: invalid x-api-key`**

Your API key is missing or wrong.

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
ethos chat
```

Verify the key works:

```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
```

**`RateLimitError: rate_limit_exceeded`**

You're hitting API rate limits. Options:
1. Wait and retry — limits reset per minute
2. Switch to a smaller model for development (`claude-haiku-4-5-20251001`)
3. Add more API keys and use `AuthRotatingProvider` from `@ethosagent/llm-anthropic`

## Session issues

**Conversation history isn't persisting**

Check that `~/.ethos/sessions.db` exists and is writable:

```bash
ls -la ~/.ethos/sessions.db
sqlite3 ~/.ethos/sessions.db ".tables"
```

If the DB is corrupted, back it up and delete it:

```bash
cp ~/.ethos/sessions.db ~/.ethos/sessions.db.bak
rm ~/.ethos/sessions.db
ethos chat   # creates a fresh DB
```

**Agent forgets context mid-conversation**

The agent uses `getMessages(sessionId, { limit: 50 })` by default. For very long conversations, earlier context is dropped. Options:

1. Use `/new` to start a fresh session when context is stale
2. Ask the agent to save key facts to memory: "Remember that X"
3. Increase the message limit in config (uses more tokens per turn)

## Tool errors

**`Tool 'X' not found`**

The tool isn't registered. Check:

1. The tool name matches exactly (case-sensitive)
2. The tool's `isAvailable()` returns `true`
3. The tool is in the personality's `toolset.yaml`

```bash
# In the CLI:
/tools   # lists all registered tools
```

**Tool results are truncated**

Large tool outputs are trimmed to fit the context budget. To get more output:

1. Ask the agent to use pagination: "Read the file 100 lines at a time"
2. Reduce the number of parallel tool calls
3. Increase `resultBudgetChars` in `AgentLoop` config (raises token costs)

## Personality issues

**`Personality 'X' not found`**

The personality directory doesn't exist or is missing required files:

```bash
ls ~/.ethos/personalities/
ls ~/.ethos/personalities/myid/
# Should contain: ETHOS.md, config.yaml, toolset.yaml
```

**Personality isn't hot-reloading**

The file-based loader caches on `config.yaml` mtime. After editing personality files, touch the config:

```bash
touch ~/.ethos/personalities/myid/config.yaml
```

## TypeScript errors

> The rest of this page covers issues you'll only hit when working from a source checkout (contributing, building plugins, or running from the monorepo). If you installed via `npm install -g @ethosagent/cli`, you can stop here.

**`Type 'X' is not assignable to type 'Y'`**

If you're extending Ethos, make sure you're using the same `@ethosagent/types` version as the host app. Mismatched versions cause interface incompatibilities.

Check versions:

```bash
pnpm list @ethosagent/types --recursive
```

**`noNonNullAssertion` lint error**

Biome blocks `!` non-null assertions. Use a guard instead:

```typescript
// Wrong
const val = map.get(key)!;

// Correct
const val = map.get(key);
if (!val) throw new Error('expected key');
```

## Build issues

**`pnpm build` fails with missing exports**

After adding a new workspace package, add its path alias to the root `tsconfig.json`:

```json
{
  "paths": {
    "@ethosagent/mypackage": ["./extensions/mypackage/src"]
  }
}
```

**`better-sqlite3` fails to install**

Native module compilation failed. Install build tools:

```bash
# macOS
xcode-select --install

# Ubuntu/Debian
sudo apt-get install build-essential python3
```

Then reinstall:

```bash
pnpm install --force
```

## Error reference

User-facing errors are rendered as a code, a one-line cause, and a suggested action:

```
✗ INVALID_INPUT: --concurrency must be a positive integer
  → Pass a positive integer, e.g. --concurrency 4.
```

If you see a code below, the action printed by the CLI is your first move. The table is the canonical list — every code that ships in `@ethosagent/types` `EthosErrorCode` appears here.

| Code | Cause | Action |
|---|---|---|
| `CONFIG_MISSING` | `~/.ethos/config.yaml` is absent or unreadable. | Run `ethos setup`. |
| `CONFIG_INVALID` | The config file parsed but is missing required fields (provider, model, apiKey). | Re-run `ethos setup`, or edit the file by hand and re-run the command. |
| `PERSONALITY_NOT_FOUND` | The configured personality ID does not match any built-in or `~/.ethos/personalities/<id>/` directory. | Run `ethos personality list` and pick a valid ID. |
| `PROVIDER_AUTH_FAILED` | The LLM provider rejected the API key. | Re-export `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, or re-run `ethos setup` and paste a fresh key. |
| `LLM_ERROR` | The LLM provider returned a non-recoverable error mid-stream. | Re-run the request. If it repeats, capture the cause and file a bug. |
| `STREAM_TIMEOUT` | The LLM streamed nothing for longer than the configured watchdog window. | Try again. Tune `streamingTimeoutMs` in the personality config if your network is slow. |
| `INVALID_INPUT` | A required CLI flag is missing or out of range. | Read the printed `Usage:` line and re-run with a valid flag. |
| `FILE_NOT_FOUND` | A path passed to a CLI flag does not exist. | Verify the path and re-run. |
| `BATCH_INVALID_LINE` | A line in the batch tasks JSONL file is missing required fields. | Open the file, fix the offending line (number printed in the cause), and re-run `ethos batch`. |
| `EVAL_INVALID_LINE` | A line in the eval expected JSONL file is malformed. | Open the file, fix the offending line, and re-run `ethos eval run`. |
| `TOOL_REJECTED` | A `before_tool_call` hook blocked the tool. | The hook's reason appears in the cause. Adjust the hook config or the tool call. |
| `TOOL_EXECUTION_FAILED` | A tool ran and returned `{ ok: false }`. | The tool's error message appears in the cause. Treat as the tool's own diagnostic. |
| `SUBAGENT_TASK_DUPLICATED` | A delegated task ended up duplicated across the child agent's prompt. | Bug — file an issue with the parent personality and the prompt that triggered it. |
| `JOB_NOT_FOUND` | The cron job ID passed to `ethos cron remove`/`run`/`disable` does not exist. | Run `ethos cron list` and copy the exact ID. |
| `JOB_DUPLICATE` | A new cron job uses an ID that's already taken. | Pick a different ID or remove the existing job first. |
| `JOB_LOCK_FAILED` | Another cron-mutating command is currently holding the lock. | Wait a moment and re-run. If it repeats, check for a stuck `ethos cron` process. |
| `CRON_INVALID` | The cron expression failed validation. | Use a valid 5-field cron expression (see `https://crontab.guru`). |
| `MCP_TRANSPORT_INVALID` | An MCP server config is missing `command` (stdio) or `url` (sse). | Edit the MCP server entry in `~/.ethos/config.yaml`. |
| `REGISTRY_FETCH_FAILED` | `ethos upgrade` could not reach `registry.npmjs.org`. | Check your network. Install manually: `npm install -g @ethosagent/cli@latest`. |
| `NETWORK_ERROR` | A network call inside the CLI failed for a reason other than registry-specific. | Re-run. Check your connection. |
| `SKILL_INSTALL_FAILED` | `ethos skills install` did not complete. The temp directory is rolled back. | Re-run the install. If the source URL is wrong, fix the slug. |
| `SKILL_NOT_FOUND` | The skill ID passed to a web Skills tab action is not in `~/.ethos/skills/`. | Refresh the Skills tab; the underlying file may have been deleted out-of-band. |
| `SKILL_EXISTS` | A new skill name collides with an existing file in `~/.ethos/skills/`. | Pick a different id, or open the existing skill from the Library panel to edit it. |
| `PLUGIN_CONTRACT_INCOMPATIBLE` | A plugin declares a `pluginContractMajor` that's not supported by this CLI. | Upgrade the plugin (or the CLI), per `packages/plugin-contract/MIGRATIONS.md`. |
| `INTERNAL` | An unexpected error escaped to the surface. | Re-run. If it repeats, file an issue with the printed `details`. |

For the recent errors hitting *your* install specifically, run `ethos doctor --recent-errors` (Phase 30.10).

## Getting help

- **GitHub Issues**: [github.com/MiteshSharma/ethos/issues](https://github.com/MiteshSharma/ethos/issues)
- **Discussions**: [github.com/MiteshSharma/ethos/discussions](https://github.com/MiteshSharma/ethos/discussions)

When filing a bug, include:
- Node version (`node --version`)
- pnpm version (`pnpm --version`)
- OS and version
- Relevant error message and stack trace
- Steps to reproduce
- The recent slice of `~/.ethos/logs/errors.jsonl` (Phase 30.10), or the lines matching the error code shown.
