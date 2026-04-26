---
title: Build Your First Agent
description: Start a chat session, send messages, observe streaming responses, and explore session persistence.
sidebar_position: 1
---

# Build Your First Agent

:::info ~5 min
Prerequisite: completed [Quickstart](../getting-started/quickstart) — `~/.ethos/config.yaml` exists.
:::

## Start a session

```bash
ethos chat
```

Ethos opens an interactive chat session. You'll see:

```
ethos v0.x.x · researcher · claude-opus-4-7
Type a message or /help for commands.
>
```

The header shows: current version, active personality, and model.

## Send a message

Type any message and press Enter. Responses stream in real-time:

```
> What's the capital of France?

Paris is the capital of France. It has served as the country's capital
since...
```

While the model is responding, tool calls appear inline:

```
> Search the web for the latest TypeScript release

[web_search] searching...
[web_search] ✓ 340ms

TypeScript 6.0 was released...
```

## Check token usage

After a few messages, run:

```
/usage
```

Output:

```
Session usage
  Input tokens:   2,847
  Output tokens:  512
  Estimated cost: $0.0041
```

## Start a fresh session

```
/new
```

This creates a new session. History from the previous session is preserved in SQLite — you can reference it in future sessions but the model won't see it immediately.

## Observe session persistence

Exit with `Ctrl+D`, then run `ethos chat` again. Send:

```
> What was the last thing we discussed?
```

The agent remembers — sessions persist in `~/.ethos/sessions.db` across restarts. Each working directory gets its own session history (the session key is `cli:<directory-name>`).

## All slash commands

```
/personality list       list available personalities
/personality <id>       switch personality
/memory                 show MEMORY.md and USER.md
/usage                  token and cost stats for this session
/new                    start a fresh session
/help                   show all commands
```

---

**Next:** [Create a custom personality →](./create-a-custom-personality)
