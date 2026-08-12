---
title: Production hardening checklist
description: Step-by-step checklist for hardening an Ethos deployment before production — secrets, tokens, network, filesystem, observability, and container settings.
kind: how-to
audience: shared
slug: production-hardening-checklist
time: "30 min"
updated: 2026-06-09
---

## Task

Harden an Ethos deployment so every security control documented in [Security controls](./controls.md) is active and verified before the first production message reaches the agent.

## Result

After completing this checklist you will have: secrets out of plaintext config, platform tokens scoped to least privilege, filesystem and network boundaries declared per personality, channel filtering active, injection defenses confirmed, observability writing and redacting, and (if containerised) a locked-down runtime.

## Prerequisites

- A working Ethos installation (`ethos` CLI responds to `ethos --version`).
- At least one personality configured under `~/.ethos/personalities/<id>/`.
- Access to the platform tokens you plan to use (Slack, Telegram, Discord, GitHub, Linear).
- Familiarity with the [threat model](./threat-model.md) and which threats are in scope for your deployment.

## Steps

### 1. Move secrets out of plaintext config

Replace every literal credential in `~/.ethos/config.yaml` with a `${secrets:ref}` substitution. Ethos resolves these at startup through the configured secrets provider.

Available providers:

| Provider | When to use |
|---|---|
| `FileSecretsResolver` | Single-machine deployments. Reads from a JSON file outside `~/.ethos/` (e.g. `/etc/ethos/secrets.json`) with restrictive file permissions. |
| `EnvSecretsResolver` | Container deployments where secrets are injected as environment variables by the orchestrator. |
| AWS Secrets Manager | Production cloud deployments. Configure the resolver with the secret ARN; values are fetched at startup and cached for the process lifetime. |

**Verify:**

```bash
# Confirm no plaintext secrets remain in config
grep -rn 'sk-ant-\|sk-\|xoxb-\|AKIA' ~/.ethos/config.yaml
# Should return no matches

# Confirm secrets resolve at startup
ethos secrets list
# Should show each ref and its resolution status (resolved / missing)
```

### 2. Scope platform tokens to minimum privilege

Each platform token (Slack, Telegram, Discord, GitHub, Linear) should be minted with the narrowest scopes the agent actually needs. Over-scoped tokens widen the blast radius if a token leaks.

- Slack: `chat:write`, `channels:read`, `users:read` -- not `admin.*`.
- Telegram: BotFather token with no payment or group-admin permissions.
- Discord: bot scope only; no `Administrator` intent.
- GitHub: fine-grained PAT scoped to specific repos, read-only where possible.
- Linear: API key scoped to the workspace; no organisation-admin access.

For per-platform scope tables and rotation instructions, see [Least-privilege tokens](./least-privilege-tokens.md).

**Verify:** Review each token's granted scopes in the platform's developer console. Confirm no token has admin-level access.

### 3. Declare filesystem reach per personality

Every personality must declare `fs_reach` in its `config.yaml` with explicit read and write paths. The global deny floor (`.ssh`, `.aws`, `/etc/shadow`, and the rest of the always-deny set) is enforced by `ScopedStorage` regardless of what `fs_reach` allows -- see [Security controls -- ScopedStorage](./controls.md#scoped-storage-and-boundary-error).

```yaml
# ~/.ethos/personalities/engineer/config.yaml
fs_reach:
  read:
    - ~/projects/myapp
  write:
    - ~/projects/myapp/src
```

A personality with no `fs_reach` declaration gets no filesystem access beyond its own personality directory.

**Verify:**

```bash
ethos personality show <id>
# Check the "Filesystem reach" section.
# Confirm read/write paths match what this personality needs — nothing more.
```

### 4. Declare network policy per personality

Personalities with web tools (`web_fetch`, `web_post`) should declare `network.allowedHosts` in their safety config. A personality without a network policy gets no egress -- the global SSRF, scheme-allowlist, and cloud-metadata controls still apply to all personalities. See [Security controls -- network](./controls.md#per-personality-network-policy).

```yaml
# In the personality's config.yaml safety block
safety:
  networkReach:
    - host: "api.github.com"
      ports: [443]
    - host: "*.slack.com"
      ports: [443]
```

**Verify:**

```bash
ethos personality show <id>
# Check the "Network reach" section.
# Confirm only the hosts this personality needs are listed.
# Confirm no wildcard entries like "*" that would allow all egress.
```

### 5. Configure channel security

Set up `channel_filter` in `~/.ethos/config.yaml` for every active channel adapter:

- **Sender allowlist:** restrict which user IDs can reach the agent. Unknown senders are dropped before the message enters the agent loop.
- **DM pairing codes:** require a one-time pairing code before a new sender can interact. Codes are sender-bound, nonce-bound, and atomically consumed.
- **Context visibility:** set the mode per channel -- `allowlist` (only allowlisted senders' content visible) or `allowlist_quote` (allowlisted senders plus their quoted context). Avoid `all` in production unless the channel is fully trusted.

See [Security controls -- channel](./controls.md#channel-level-controls) for the full set of channel-layer controls.

```yaml
channel_filter:
  telegram:
    allowedSenders:
      - "123456789"   # numeric user ID
    pairingEnabled: true
    contextVisibility: "allowlist"
  slack:
    allowedSenders:
      - "U01ABC123"
    contextVisibility: "allowlist_quote"
```

**Verify:** Send a message from a non-allowlisted account. Confirm it is silently dropped and a `channel.deny` event appears in `observability.db`.

### 6. Confirm injection defenses are active

The `INJECTION_DEFENSE_PRELUDE` system prompt is always-on -- it is injected into every personality's prompt automatically. No action is needed to enable it.

Confirm that `wrapUntrusted` covers all untrusted input surfaces:

- **Channel messages** from non-owner senders are wrapped with provenance markers.
- **Tool results** from web fetches, email reads, and skill outputs are wrapped before re-entering the LLM context.
- **Quoted and forwarded content** is tagged as untrusted by the context-visibility filter.

The only case where action is required: if you have written **custom tools** that return external content and bypass the standard tool pipeline, those results will not be wrapped automatically. Wrap them manually with the `wrapUntrusted()` helper from `@ethosagent/safety-injection`.

**Verify:** No explicit verification step unless you have custom tools. If you do, confirm each custom tool's `execute()` calls `wrapUntrusted()` on any external content before returning it as a `ToolResult`.

### 7. Set up observability and retention

Confirm the audit substrate is writing:

```bash
# Check that observability.db exists and is receiving events
ls -la ~/.ethos/observability.db
sqlite3 ~/.ethos/observability.db "SELECT category, COUNT(*) FROM events GROUP BY category;"
```

Confirm credential redaction is active. Redaction is always-on at the observability store layer -- `redactString` and `redactJson` fire before any value reaches disk. The per-personality `safety.observability` knob controls storage granularity:

| Mode | What is stored |
|---|---|
| `none` | Events only (no tool args, no tool bodies, no LLM payloads) |
| `redacted` | Tool args and bodies stored after pattern-based redaction |
| `full` | Everything stored (use only in development) |

Set retention policies per audit category. Production deployments should retain `audit.*` and `channel.*` events for at least 90 days.

```yaml
# In config.yaml
observability:
  retention:
    "audit.*": "90d"
    "channel.*": "90d"
    "install.*": "30d"
```

**Verify:**

```bash
# Confirm redaction is working — inject a test key pattern and check the log
sqlite3 ~/.ethos/observability.db \
  "SELECT data FROM events ORDER BY rowid DESC LIMIT 5;"
# No raw API keys (sk-ant-*, AKIA*, xoxb-*) should appear in the output.
```

### 8. Harden the container (Docker deployments)

If running Ethos in Docker, apply these constraints:

| Setting | Value | Why |
|---|---|---|
| User | Non-root (`USER 1000:1000`) | Limits blast radius of any escape |
| Root filesystem | Read-only (`--read-only`) | Prevents runtime binary replacement |
| Inbound ports | None, unless the web API is exposed | Reduces attack surface |
| Healthcheck | `HEALTHCHECK CMD ethos health` | Orchestrator can restart a stuck process |
| Volume for `~/.ethos/` | EBS-backed (or equivalent persistent volume) | Survives container restarts; WAL needs a real filesystem |
| Tmpfs | Mount `/tmp` as tmpfs | Scratch space without persisting to the volume |

Example `docker run`:

```bash
docker run \
  --user 1000:1000 \
  --read-only \
  --tmpfs /tmp \
  -v /data/ethos:/home/ethos/.ethos \
  --health-cmd="ethos health" \
  --health-interval=30s \
  ethos:latest
```

**Verify:**

```bash
# Inside the container
whoami          # Should NOT be root
touch /bin/test # Should fail (read-only root FS)
```

### 9. Validate bot bindings (multi-bot deployments)

In multi-bot deployments the gateway holds a `Map<botKey, AgentLoop>` -- one loop per configured bot. Each bot binding must point to an existing personality and team.

- Confirm every `botKey` in the config maps to a personality directory under `~/.ethos/personalities/`.
- Confirm each bot's `platform` and `token` pair is correct.
- Confirm `botKey` values are stable across restarts (use the `id:` field in config, or accept the sha256-derived default).

Run the config strict loader to catch dangling references:

```bash
ethos config validate --strict
# Should exit 0 with no warnings about missing personalities or teams.
```

**Verify:** Restart the gateway. Confirm all bots connect and the observability log shows a startup event for each `botKey`.

### 10. Document backup and token rotation

Production credentials rotate. Document:

- **Which tokens** are in use (platform, scope, last rotated).
- **Where they are stored** (secrets provider, ARN, env var name).
- **How to rotate** without downtime (mint new token, update the secret, restart the gateway, revoke the old token).
- **Rotation cadence** -- at minimum every 90 days for platform tokens, immediately if a leak is suspected.

For a step-by-step rotation procedure, see [Bot token rotation playbook](./bot-token-rotation-playbook.md).

**Verify:** Perform a dry-run rotation of one non-critical token. Confirm the gateway reconnects with the new token and the old token is revoked.

### 11. Enable admin panel token authentication

Generate an admin token via `ethos token create`. Configure the web API to require the token on every request. Confirm unauthenticated requests receive `401 Unauthorized`.

**Verify:**

```bash
# Request without token — should return 401
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/sessions
# 401

# Request with token — should return 200
curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ETHOS_TOKEN" \
  http://localhost:3000/api/sessions
# 200
```

See [Security controls -- admin panel token authentication](./controls.md#admin-panel-token-auth).

### 12. Restrict CORS for remote desktop connections

If Mission Control connects to a remote Ethos instance, set `cors.allowedOrigins` in `~/.ethos/config.yaml` to the exact origin of the desktop app. Do not use `*`.

```yaml
# ~/.ethos/config.yaml
cors:
  allowedOrigins:
    - "https://mission-control.example.com"
```

**Verify:** Open the browser console on the desktop app and confirm no CORS errors. Attempt a request from a different origin and confirm it is rejected.

See [Security controls -- desktop remote connection security](./controls.md#desktop-remote-connection) and [Deploy Mission Control with a remote Ethos](../building/how-to/deploy-mission-control-remote.md).

### 13. Review plugin data source permissions

Confirm every plugin data source is registered as read-only. The dashboard query executor enforces read-only transactions, but review that no plugin bypasses the `registerDataSource` path with direct database access.

**Verify:**

```bash
# Attempt a write query via the dashboard — should be rejected
curl -s -X POST -H "Authorization: Bearer $ETHOS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "DROP TABLE test"}' \
  http://localhost:3000/api/data-sources/my-plugin/query
# Should return an error indicating write operations are not allowed
```

See [Security controls -- read-only plugin data source access](./controls.md#read-only-sql) and [Register a plugin data source](../building/how-to/register-plugin-data-source.md).

## Verify

Run the config strict loader to confirm no warnings remain:

```bash
ethos config validate --strict
```

Then run a quick end-to-end smoke test: send a message from a non-allowlisted account and confirm it is dropped. Send a message from an allowlisted account and confirm `observability.db` records the expected `channel.allow`, `audit.tool_call`, and redaction events. Check that no plaintext secrets appear in the audit output:

```bash
sqlite3 ~/.ethos/observability.db \
  "SELECT category, COUNT(*) FROM events GROUP BY category;"
```

If every step above passes, the deployment is hardened.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ethos secrets list` shows `missing` for a ref | Secret not found in the configured provider | Add the secret to the provider (file, env, or Secrets Manager) |
| `BoundaryError` on a path the personality should reach | `fs_reach` too narrow or symlink resolving outside the allowlist | Widen `fs_reach` to include the resolved real path |
| Agent responds to unknown senders | `channel_filter` not configured or `allowedSenders` empty | Add sender IDs to the allowlist; enable pairing |
| `observability.db` is empty | Database path misconfigured or the process lacks write permission | Check `observability.db` path in config; confirm the process user can write to it |
| Container crashes on startup with read-only FS | `~/.ethos/` not mounted as a writable volume | Mount a persistent volume at the `~/.ethos/` path |
| `ethos config validate --strict` reports missing personality | Bot binding references a personality ID that does not exist | Create the personality directory or fix the `botKey` mapping |
| Admin panel returns `401` for all requests | Token not generated or not passed in the `Authorization` header | Run `ethos token create` and pass the token as `Bearer <token>` |
| CORS error in Mission Control desktop app | `cors.allowedOrigins` does not include the desktop app origin | Add the exact origin to `cors.allowedOrigins` in `config.yaml` |
| Dashboard query returns data from a write statement | Plugin bypasses `registerDataSource` with direct DB access | Audit plugin code; route all queries through `registerDataSource` |

## See also

- [Security controls](./controls.md) -- the full catalogue of shipped controls.
- [Threat model](./threat-model.md) -- what Ethos defends against and what is out of scope.
- [How does Ethos defend against the threats it knows about?](./overview.md) -- the layered model and runtime precedence.
- [Pre-launch hardening pass](./security-fixes.md) -- sixteen issues surfaced and fixed before shipping.
- [Least-privilege tokens](./least-privilege-tokens.md) -- per-platform scope tables.
- [Bot token rotation playbook](./bot-token-rotation-playbook.md) -- step-by-step rotation procedure.
- [Why should agents never hold database credentials?](./api-mediated-access.md) -- reference architecture for API-mediated data access.
- [Why run one process per personality in production?](./process-isolation.md) -- when to split from shared-process to one-pod-per-personality.
