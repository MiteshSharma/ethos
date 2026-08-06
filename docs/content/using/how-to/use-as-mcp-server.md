---
title: "Use Ethos as an MCP server"
description: "Expose Ethos to Claude Desktop, Cursor, OpenCode, Continue, or Zed via the Model Context Protocol stdio server."
kind: how-to
audience: user
slug: use-as-mcp-server
time: "5 min"
updated: 2026-05-12
---

## Task

Run `ethos mcp serve` as a stdio MCP server so an MCP-compatible client (Claude Desktop, Cursor, OpenCode, Continue, Zed) can call Ethos [personalities](../../getting-started/glossary.md#personality), read [memory](../../getting-started/glossary.md#memory), and invoke prompts.

## Result

The client's tool palette lists `ask_personality`, `list_personalities`, and `search_memory`, and reads `ethos://memory/...` resources from your local install.

## Prereqs

- `ethos` installed and a provider configured ([Configure an LLM provider](configure-providers.md)).
- An MCP-compatible client. The bundled adapters cover Claude Desktop, Cursor, OpenCode, Continue, and Zed.
- `ethos --version` works in a fresh shell — the client invokes Ethos as a subprocess and inherits a stripped environment.

## What gets exposed

The MCP server lives in [`apps/mcp-server/src/`](https://github.com/ethosagent/ethos/blob/main/apps/mcp-server/src/index.ts). Three primitives surface to the client:

| Kind | Identifier | What it does |
|---|---|---|
| Tool | `ask_personality(personality_id, prompt)` | Run a prompt through the named personality and stream the response back. |
| Tool | `list_personalities()` | Return the personality roster, descriptions, and visible toolsets. |
| Tool | `search_memory(query)` | Search `MEMORY.md` and `USER.md`. |
| Resource | `ethos://memory/MEMORY.md` | The rolling project memory. |
| Resource | `ethos://memory/USER.md` | The user-identity memory. |
| Resource | `ethos://personalities/<id>/SOUL.md` | A personality's identity file. |
| Resource | `ethos://sessions/recent` | Index of recent sessions. |
| Prompt | `code_review`, `research_topic`, `reflect_on_decision`, `debug_failure` | Ready-to-invoke prompt templates. |

Transport is stdio only. The server is a subprocess the client owns — there is no HTTP, no TLS, no auth surface, no multi-tenancy.

## Steps

### 1. Install Ethos into the client's config

```bash
ethos mcp install claude-desktop
ethos mcp install cursor
ethos mcp install opencode
ethos mcp install continue
ethos mcp install zed
```

Each command writes the `mcpServers` entry (or the equivalent shape for that client) into the client's config file with the absolute path to your `node` binary and the `ethos` script. The exact path lands in `ethos mcp doctor` output for inspection.

Then restart the client. Claude Desktop in particular caches the MCP server list at launch.

### 2. Inspect what the client will see

```bash
ethos mcp inspect
```

Lists the tools, resources, and prompts the server will expose. The output is read-only — no server starts.

### 3. Smoke-test the install

```bash
ethos mcp doctor
```

`doctor` reports:

- The `node` binary path and the `ethos` script path the client will spawn.
- Which client config files exist and whether each one has an Ethos entry (`[✓]` vs `[ ]`).
- The command the client will run on startup.

If `[✓]` appears next to your client, the registration is live. Open the client; ask: "Ask the researcher: what's interesting in `./docs/`?" — the model invokes `ask_personality` and Ethos streams the answer back.

### 4. Configure a client manually

If `ethos mcp install` doesn't know your client, print the canonical snippet:

```bash
ethos mcp init
```

The default shape (Claude Desktop, Cursor):

```json
{
  "mcpServers": {
    "ethos": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/ethos", "mcp", "serve"]
    }
  }
}
```

For OpenCode (`~/.config/opencode/config.json`):

```json
{
  "mcp": {
    "servers": {
      "ethos": {
        "type": "local",
        "command": ["/absolute/path/to/node", "/absolute/path/to/ethos", "mcp", "serve"]
      }
    }
  }
}
```

For Zed (`settings.json`):

```json
{
  "context_servers": {
    "ethos": {
      "command": {
        "path": "/absolute/path/to/node",
        "args": ["/absolute/path/to/ethos", "mcp", "serve"]
      }
    }
  }
}
```

`ethos mcp init <client>` prints the exact snippet pre-filled with `process.execPath` and `process.argv[1]` for that client.

### 5. Run the server directly

For debugging or for a custom client, run the server in the foreground:

```bash
ethos mcp serve
```

The process speaks JSON-RPC on stdin/stdout. All logging goes to stderr — anything stray on stdout corrupts the JSON-RPC frame and the client disconnects.

## Verify

```bash
ethos mcp doctor
```

A `[✓]` next to the target client's config path, and a non-error launch when the client starts, is the end state. Inside the client, the `ask_personality` tool returns a streamed response — that's the round-trip working.

## Troubleshoot

**Client starts but Ethos tools never appear.** — The client launched Ethos with a stripped `PATH` and failed to resolve the binary. Re-run `ethos mcp install <client>` — the install writes absolute paths to `node` and the `ethos` script.

**Garbled output in the client log.** — Something wrote to stdout. The server reserves stdout for JSON-RPC frames; any `console.log` from a plugin breaks the channel. Run `ethos mcp serve` directly and look for stray writes.

**`No ~/.ethos/config.yaml found.`** — The server requires a config to start. Run `ethos setup`. The error goes to stderr; the client surfaces it as a startup failure.

**Personality not visible to the client.** — The personality's toolset references tools the client cannot satisfy through MCP. The server filters those out at handshake. `ethos mcp doctor` notes what was dropped and why.

**Two Ethos installs, wrong one resolves in the client.** — `ethos mcp install` writes `process.execPath` (the Node binary that ran `ethos mcp install`). Run the install from the shell whose `ethos` you actually want, then restart the client.

**Client config did not update.** — The install writes to the path returned by the client adapter's `configPath()`. `ethos mcp doctor` prints that path; if it's wrong for your setup, edit the file manually using the snippet from `ethos mcp init <client>`.
