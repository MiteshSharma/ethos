---
sidebar_position: 11
title: Troubleshooting
---

# Troubleshooting

Common issues and how to fix them.

## CLI won't start

**Error: `Cannot find module '@ethosagent/core'`**

Path aliases aren't resolving. This happens if you run `node` directly instead of `tsx`:

```bash
# Wrong
node apps/ethos/src/index.ts

# Correct
pnpm dev
# or
npx tsx apps/ethos/src/index.ts
```

**Error: `config.yaml not found`**

The setup wizard didn't complete. Delete `~/.ethos/` and run `pnpm dev` again to trigger setup:

```bash
rm -rf ~/.ethos
pnpm dev
```

## API errors

**`AuthenticationError: invalid x-api-key`**

Your API key is missing or wrong.

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
pnpm dev
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
pnpm dev   # creates a fresh DB
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

## Getting help

- **GitHub Issues**: [github.com/ethosagent/ethos/issues](https://github.com/ethosagent/ethos/issues)
- **Discussions**: [github.com/ethosagent/ethos/discussions](https://github.com/ethosagent/ethos/discussions)

When filing a bug, include:
- Node version (`node --version`)
- pnpm version (`pnpm --version`)
- OS and version
- Relevant error message and stack trace
- Steps to reproduce
