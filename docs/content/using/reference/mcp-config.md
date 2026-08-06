---
title: "MCP config reference"
description: "Field-by-field reference for ~/.ethos/mcp.json: transports, OAuth 2.1, bearer token auth, env sandboxing, secret indirection, personality scoping."
kind: reference
audience: user
slug: mcp-config
updated: 2026-06-03
---

## Synopsis {#synopsis}

Ethos's MCP client reads servers from `~/.ethos/mcp.json`. The file is a **JSON array**; each entry is an `McpServerConfig`. Source of truth: [`McpServerConfig`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-mcp/src/index.ts) in `@ethosagent/tools-mcp`.

```json
[
  {
    "name": "filesystem",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/work"]
  },
  {
    "name": "github",
    "transport": "streamable-http",
    "url": "https://api.githubcopilot.com/mcp",
    "auth": {
      "type": "oauth2",
      "authorization_endpoint": "https://github.com/login/oauth/authorize",
      "token_endpoint": "https://github.com/login/oauth/access_token",
      "client_id": "Iv1.b507a08c87ecfe98"
    }
  }
]
```

Reload semantics: configuring a server here makes it **available**; it does not **attach** to any personality. See [Personality scoping](#scoping).

## Adding servers from the UI {#ui-flow}

The web UI offers a guided flow for OAuth-protected MCP servers: **Plugins → MCP Servers tab → Add MCP**. Before the OAuth redirect, the UI requires selecting a [personality](../../getting-started/glossary.md#personality) from the personality dropdown — tokens are stored per-personality, not globally. The modal handles OAuth discovery, dynamic client registration, and token storage automatically. Servers added through the UI are written to the same `~/.ethos/mcp.json` and are fully compatible with the CLI commands below.

## CLI workflow {#cli-workflow}

The CLI splits MCP setup into two steps: **define** the server, then **authenticate** per-personality.

### 1. Register the server {#register-server}

```bash
ethos mcp add --url https://mcp.linear.app
```

This writes an entry to `~/.ethos/mcp.json` (with OAuth discovery, OSV scan, etc.) but stores **no token**. The server is now available to any personality that lists it in `mcp_servers:`, but unauthenticated calls will fail until a token is acquired.

### 2. Acquire a per-personality token {#acquire-token}

```bash
ethos mcp login linear --personality engineer
```

This runs the PKCE flow (opening a browser for OAuth servers) and stores the resulting token at the per-personality path: `~/.ethos/personalities/engineer/mcp/linear/access_token`. Each personality that needs access must run `login` separately — tokens are never shared across personalities.

To revoke:

```bash
ethos mcp logout linear --personality engineer
```

This calls the revocation endpoint (if configured) and removes the stored token files.

## Server entry {#server-entry}

Every entry carries these fields. The `transport` choice gates which transport-specific fields apply.

| Field | Type | Default | Required | Description |
|---|---|---|---|---|
| `name` | string | — | yes | Stable id for this server. Tool names emit as `mcp__<name>__<tool>`. Reuse breaks the registry — keep unique. |
| `transport` | `'stdio' \| 'streamable-http' \| 'sse'` | — | yes | Subprocess vs HTTP. `sse` is deprecated and removed in the next minor — switch to `streamable-http`. |
| `keepaliveSeconds` | number | `30` | no | Period between ping frames; `0` disables. |
| `connectTimeoutMs` | number | `10000` | no | Initial handshake budget. Failed handshakes auto-reconnect with backoff. |
| `auth` | object | — | no | Auth block. `oauth2` or `bearer`. HTTP only. See [OAuth 2.1](#oauth), [Bearer auth](#bearer). |

### stdio fields {#stdio-fields}

Set on entries where `transport: "stdio"`.

| Field | Type | Default | Required | Description |
|---|---|---|---|---|
| `command` | string | — | yes | Executable. Resolved via `PATH` of the **sandboxed env** (see [Sandboxed environment](#sandbox)). |
| `args` | string[] | `[]` | no | Argument list passed to the subprocess. |
| `env` | Record\<string,string\> | `{}` | no | Extra env vars set on the subprocess. Always **merged** on top of the sandboxed env; pinned keys (`HOME`, `TMPDIR`, `XDG_*`) cannot be overridden — those are routed to a per-server scratch directory. |
| `mcpEnvPassthrough` | string[] | `[]` | no | Process env vars to forward through the sandbox. Required for credential-pattern names (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`) which are otherwise stripped. See [Sandboxed environment](#sandbox). |

### streamable-http fields {#http-fields}

Set on entries where `transport: "streamable-http"`.

| Field | Type | Default | Required | Description |
|---|---|---|---|---|
| `url` | string | — | yes | Server endpoint. Must be `https://`. |
| `headers` | Record\<string,string\> | `{}` | no | Request headers. Use `${secrets:<ref>}` for credentials — see [Secret indirection](#secrets). |

## OAuth 2.1 {#oauth}

Servers that require an authorization flow declare an `auth` block. Ethos walks the MCP SDK's PKCE flow on first connect, persists tokens through `SecretsResolver`, and refreshes silently on expiry. Re-auth in the browser is required only when refresh itself fails.

```json
{
  "name": "linear",
  "transport": "streamable-http",
  "url": "https://mcp.linear.app",
  "auth": {
    "type": "oauth2",
    "authorization_endpoint": "https://linear.app/oauth/authorize",
    "token_endpoint": "https://api.linear.app/oauth/token",
    "client_id": "<your-app-client-id>",
    "scopes": ["read", "write"],
    "revocation_endpoint": "https://api.linear.app/oauth/revoke"
  }
}
```

| Field | Type | Default | Required | Description |
|---|---|---|---|---|
| `type` | `'oauth2'` | — | yes | The only value today. |
| `authorization_endpoint` | string | — | yes | Authorization server's `/authorize` URL. |
| `token_endpoint` | string | — | yes | Token exchange + refresh URL. |
| `client_id` | string | — | yes | Public client identifier registered with the server. |
| `scopes` | string[] | `[]` | no | Scopes to request at authorize time. |
| `revocation_endpoint` | string | — | no | RFC 7009 revocation endpoint. Used when the operator runs `ethos mcp logout <name>`. |

Token storage paths (per-personality, owner-only 0600):

| Path | Contents |
|---|---|
| `~/.ethos/personalities/<id>/mcp/<name>/access_token` | Current bearer token |
| `~/.ethos/personalities/<id>/mcp/<name>/refresh_token` | Refresh credential (when issued) |
| `~/.ethos/personalities/<id>/mcp/<name>/expires_at` | RFC 3339 expiry timestamp |

Tokens are scoped to each personality. Two personalities using the same MCP server hold independent tokens — revoking one does not affect the other.

Source of truth: [`oauth.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-mcp/src/oauth.ts).

## Bearer token auth {#bearer}

Servers that accept a static API key use `auth.type: "bearer"`. Ethos reads the token from the personality's secrets store and attaches it as `Authorization: Bearer <token>` on every request. There is no browser flow and no refresh loop — update the token file and it takes effect on the next MCP request.

```json
{
  "name": "lookout",
  "transport": "streamable-http",
  "url": "https://lookout.example.com/mcp",
  "auth": { "type": "bearer" }
}
```

Token storage path (per-personality, owner-only 0600):

| Path | Contents |
|---|---|
| `~/.ethos/personalities/<id>/mcp/<name>/access_token` | API key |

### Setting the token via the web UI {#bearer-web}

Open the personality detail page. Each bearer-auth server row shows **Set token** (when no token is stored) or **Update token** (when one exists). Paste the key and confirm. The connection status updates on the next status poll; no daemon restart is needed.

### Per-personality vs global token {#bearer-vs-global}

The `auth.type: "bearer"` pattern and the `headers` secret-indirection pattern both send the same `Authorization` header — they differ in where the token resolves from.

| Pattern | Token path | Scope |
|---|---|---|
| `auth.type: "bearer"` | `personalities/<id>/mcp/<name>/access_token` | Per-personality. Independent tokens per personality. |
| `headers: { Authorization: "Bearer ${secrets:ref}" }` | `secrets/<ref>` | Global. All personalities share one token. |

Use `auth.type: "bearer"` when different personalities need separate API keys for the same server. Use the `headers` pattern when a single key covers all personalities.

## Sandboxed environment {#sandbox}

stdio servers run with a **minimal env**, not the operator's full process env. The default allowlist is `PATH`, `USER`, `LANG`, `LC_ALL`, `TERM`, `SHELL`. Everything else is stripped before the server starts.

Additional rules applied by `buildMcpEnv` in [`@ethosagent/safety-scanner`](https://github.com/ethosagent/ethos/blob/main/packages/safety/scanner/src/mcp-env.ts):

1. **Credential-pattern strip.** Any var whose name matches `(^|_)(KEY|TOKEN|SECRET|PASSWORD)($|_)` (case-insensitive) is removed unless explicitly listed in `mcpEnvPassthrough`. `API_KEY` and `OPENAI_API_KEY` are stripped; `KEYSTONE` and `MASTODON` are kept.
2. **Pinned scratch dirs.** `HOME`, `TMPDIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` are pinned to `~/.ethos/mcp-runtime/<name>/` (mode 0700). The subprocess cannot read `~/.aws`, `~/.ssh`, `~/.npmrc`, or any other dotfile from the operator's real home.
3. **Per-server isolation.** Each server's scratch dir is distinct — `filesystem` cannot read `~/.ethos/mcp-runtime/github/`.

To grant a credential to a stdio server, name it explicitly:

```json
{
  "name": "github",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "mcpEnvPassthrough": ["GITHUB_PERSONAL_ACCESS_TOKEN"]
}
```

The token still has to exist in the operator's env at runtime; `mcpEnvPassthrough` just stops Ethos from stripping it.

## Secret indirection {#secrets}

Never inline plaintext credentials in `mcp.json`. Use `${secrets:<ref>}` — Ethos's `SecretsResolver` substitutes the value at boot, reading plaintext from `~/.ethos/secrets/<ref>` (mode 0600, parent dir 0700).

```json
{
  "name": "stripe",
  "transport": "streamable-http",
  "url": "https://mcp.stripe.com",
  "headers": {
    "Authorization": "Bearer ${secrets:stripe/api_key}"
  }
}
```

Store the secret with:

```bash
ethos secrets set stripe/api_key sk_live_…
```

The resolver is lenient: a value that doesn't match the `${secrets:<ref>}` pattern is returned as-is. That means raw plaintext "works" — but it's a bug to ship config that way. See the [Config field reference](config-yaml.md) for the broader pattern.

## Personality scoping {#scoping}

Configuring a server in `mcp.json` makes it **available** to Ethos. It does **not** automatically expose the server's tools to any personality. Each personality declares an allowlist in its own `config.yaml`:

```yaml
# ~/.ethos/personalities/engineer/config.yaml
mcp_servers:
  - filesystem
  - github
```

The boot log line `MCP: 0 of N server(s) attached to "<personality>"` means the operator configured N servers globally but the personality has an empty allowlist. Fix at the attachment layer:

```bash
ethos personality mcp engineer --attach filesystem
ethos personality mcp engineer --detach filesystem
ethos personality mcp engineer            # list current attachments
```

The personality registry watches `config.yaml`'s mtime and reloads on the next turn — no daemon restart needed.

See also the [`native-mcp`](https://github.com/ethosagent/ethos/blob/main/skills/data/framework/native-mcp/SKILL.md) bundled skill for the operator workflow this reference is the schema for.

## Tool naming {#tool-naming}

Every MCP tool is registered under the name `mcp__<name>__<tool>` — double underscore separators, exactly. The format is part of the tool registry's contract; don't transform it elsewhere.

```
mcp__filesystem__read_file
mcp__github__create_issue
mcp__stripe__list_customers
```

A personality's `toolset.yaml` references MCP tools by this full prefixed name. The personality registry's `toolset.yaml` allowlist still applies on top of the `mcp_servers:` attachment — both gates must pass for a tool to surface to the LLM.

The agent loop emits the same prefixed name in `tool_start` / `tool_end` events. Channel adapters and the web UI display them verbatim.

## OSV vulnerability scan {#osv}

When a stdio server is added via `ethos mcp add`, Ethos queries `api.osv.dev` for advisories against the npm package version invoked in `args`. The CLI prompts on findings:

| Severity | Behavior |
|---|---|
| `critical`, `high` | Connection refused by default. The CLI prints the advisory IDs and links and exits non-zero. |
| `moderate`, `low` | Surfaced as a warning. The operator confirms before the server is written to `mcp.json`. |

To skip the scan for a server that has known advisories you've evaluated, pass `--force` to `ethos mcp add`. There is no per-server opt-out flag in `mcp.json` itself — the scan runs at install time, not at every boot.

Source of truth: [`osv-check.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-mcp/src/osv-check.ts).

## Examples {#examples}

### Filesystem (stdio, no credentials) {#example-filesystem}

```json
{
  "name": "filesystem",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/work"]
}
```

### GitHub (stdio, token via passthrough) {#example-github}

```json
{
  "name": "github",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "mcpEnvPassthrough": ["GITHUB_PERSONAL_ACCESS_TOKEN"]
}
```

The operator must export `GITHUB_PERSONAL_ACCESS_TOKEN` in their shell. The token bypasses the credential-pattern strip because it's explicitly listed.

### Stripe (HTTP, bearer via secret resolver) {#example-stripe}

```json
{
  "name": "stripe",
  "transport": "streamable-http",
  "url": "https://mcp.stripe.com",
  "headers": {
    "Authorization": "Bearer ${secrets:stripe/api_key}"
  },
  "keepaliveSeconds": 60,
  "connectTimeoutMs": 15000
}
```

Stored once with `ethos secrets set stripe/api_key sk_live_…`. The header value is the literal string `${secrets:stripe/api_key}` in `mcp.json`.

### Linear (HTTP, OAuth 2.1) {#example-linear}

```json
{
  "name": "linear",
  "transport": "streamable-http",
  "url": "https://mcp.linear.app",
  "auth": {
    "type": "oauth2",
    "authorization_endpoint": "https://linear.app/oauth/authorize",
    "token_endpoint": "https://api.linear.app/oauth/token",
    "client_id": "<app-client-id>",
    "scopes": ["read", "write"]
  }
}
```

First connect opens a browser for the PKCE flow. Tokens land at `~/.ethos/personalities/<id>/mcp/linear/{access_token,refresh_token,expires_at}` (where `<id>` is the personality that ran `ethos mcp login`) and refresh silently thereafter.

### Lookout (HTTP, bearer token) {#example-bearer}

```json
{
  "name": "lookout",
  "transport": "streamable-http",
  "url": "https://lookout.example.com/mcp",
  "auth": { "type": "bearer" }
}
```

After registering the server, set the per-personality token from the personality detail page (**Set token**), or write the file directly:

```bash
mkdir -p ~/.ethos/secrets/personalities/<id>/mcp/lookout
printf '%s' 'tok_…' > ~/.ethos/secrets/personalities/<id>/mcp/lookout/access_token
chmod 0600 ~/.ethos/secrets/personalities/<id>/mcp/lookout/access_token
```

Click **Test connection** on the server row to verify tools surface correctly.

## Common errors {#errors}

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find package '@modelcontextprotocol/sdk'` | Workspace dep missing | `pnpm install` from repo root |
| Server listed but tools missing | Server failed to start | Check `~/.ethos/logs/mcp/<name>.log` |
| `0 of N server(s) attached to "<personality>"` | Personality has no `mcp_servers` allowlist | `ethos personality mcp <id> --attach <name>` |
| HTTP server returns 401 on every call | Token expired or wrong | Re-issue and update the secret with `ethos secrets set`; for OAuth, run `ethos mcp logout <name> --personality <id>` and reconnect |
| Server can't read `~/.ssh` or `~/.aws` | Sandboxed env strips the operator's `HOME` | This is intentional. If the server legitimately needs a file, copy it into `~/.ethos/mcp-runtime/<name>/` or pass the path via an env var listed in `mcpEnvPassthrough` |
| Credential env var "missing" inside the server | Credential-pattern strip removed it | Add the var name to `mcpEnvPassthrough` |
| Bearer server shows `missing` status in web UI | Token file not found for this personality | Open the personality detail page and click **Set token**, or write `~/.ethos/secrets/personalities/<id>/mcp/<name>/access_token` directly (mode 0600) |
| Tool name `mcp__<a>__<tool>` resolves but personality can't call it | Personality's `toolset.yaml` lacks the entry | Add `- mcp__<a>__<tool>` to the personality's toolset, OR omit the per-tool list to inherit everything the server exposes |

## See also {#see-also}

- [Set up MCP for a personality](../how-to/set-up-mcp-for-a-personality.md) — step-by-step walkthrough of the two-step CLI flow and the web OAuth path.
- [Use Ethos as an MCP server](../how-to/use-as-mcp-server.md) — the inverse: serving personalities to Claude Desktop, Cursor, Continue, Zed.
- [`native-mcp`](https://github.com/ethosagent/ethos/blob/main/skills/data/framework/native-mcp/SKILL.md) — bundled skill that wraps the operator workflow.
- [Config field reference](config-yaml.md) — `~/.ethos/config.yaml` and the `${secrets:<ref>}` pattern.
- [Personality config](personality-yaml.md) — the `mcp_servers:` attachment list.
- [`tools-mcp` source](https://github.com/ethosagent/ethos/blob/main/extensions/tools-mcp/src/index.ts) — `McpServerConfig` interface.
