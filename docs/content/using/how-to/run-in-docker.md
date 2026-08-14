---
title: Run Ethos in Docker
description: Run Ethos via Docker Compose — one API key and one command for a talking web UI on localhost:3000, or the three-service operator topology.
kind: how-to
audience: user
slug: run-in-docker
time: 10 min
updated: 2026-08-14
---

Run Ethos via Docker Compose. Set one provider API key, run one command, and get a web UI you can talk to. Config is provisioned by the CLI (`ethos setup --from-env`), which validates your key before writing it — no interactive setup, no hand-edited YAML.

## Task

Run Ethos via Docker Compose with at least one provider API key.

## Result

Web UI at `http://localhost:3000` that opens directly in chat, config validated and written into a named volume. Config and session data persist across restarts.

## Prerequisites

- Docker 24+ with Compose v2 (`docker compose` subcommand, not the legacy `docker-compose` binary).
- At least one provider API key (Anthropic, OpenAI, OpenRouter, Google, or Azure).

The shipped image does **not** include `ffmpeg`. Everything except spoken replies on channels works without it; to get those, add `ffmpeg` to the runtime stage of `docker/Dockerfile` (`apt-get install -y --no-install-recommends ffmpeg`) and rebuild. Without it the gateway still starts, prints a `⚠ ffmpeg not found` notice, and delivers voice notes only in formats the TTS provider already emits — see [Send and receive voice notes on a channel](voice-notes-on-channels.md).

## Quick start (single service)

The single-service profile is the fastest path: one service, one volume, one command. Put a key in `.env` next to the compose file, then bring it up.

```bash
echo "ANTHROPIC_API_KEY=sk-ant-…" > docker/.env
docker compose -f docker/docker-compose.single.yml up
```

Watch for the final line from the boot output:

```
✓ Config validated — web UI: http://localhost:3000
```

Open `http://localhost:3000`. The SPA lands directly in chat — the key from `.env` is already validated and written, so you are never re-asked for it. Type a message and the first reply streams back.

At boot the entrypoint runs `ethos setup --from-env` (gated by `ETHOS_PROVISION_FROM_ENV=1`): it validates the provider key, writes `config.yaml` into the volume once, and re-syncs secrets from `.env` on every restart. A rejected key (401) stops the boot with an actionable final line — for example `ANTHROPIC_API_KEY rejected (401) — check the key in .env and re-run docker compose up`.

## Three-service topology (operators)

For separate web and gateway processes — the operator setup — use the three-service compose file. It runs a one-shot `init` service, then long-running `ethos-web` (port 3000) and `ethos-gateway` services.

```bash
echo "ANTHROPIC_API_KEY=sk-ant-…" > docker/.env
docker compose -f docker/docker-compose.yml up
```

The `init` service runs the same `ethos setup --from-env` provisioning, validates the key, writes `config.yaml`, then exits. Both runtime services wait for it (`depends_on: service_completed_successfully`) so they never start against a missing config. Subsequent runs re-sync secrets from `.env` and preserve any edits you made to `config.yaml` in the volume.

## Verify

```bash
curl -fsS http://localhost:3000/healthz
# {"status":"ok","uptime":42.1}
```

Check the init service exited cleanly:

```bash
docker compose -f docker/docker-compose.yml ps init
# State should be "exited (0)"
```

## Required env vars

At least one must be set. `ethos setup --from-env` uses the first one it finds, in priority order:

| Variable | Provider | Notes |
|---|---|---|
| `AZURE_API_KEY` | Azure OpenAI | requires `AZURE_ENDPOINT` |
| `ANTHROPIC_API_KEY` | Anthropic (Claude) | — |
| `OPENAI_API_KEY` | OpenAI | — |
| `OPENROUTER_API_KEY` | OpenRouter | — |
| `GOOGLE_API_KEY` | Google (Gemini) | — |

Set `TELEGRAM_BOT_TOKEN` (and optionally `TELEGRAM_OWNER_ID`) to provision a Telegram bot in the same pass. Tokens are validated before they are written: a rejected token (401) stops the boot; an unreachable endpoint is saved unverified with a warning. Set `ETHOS_SKIP_VALIDATION=1` to bypass all probes on air-gapped boots.

## Mode-aware healthcheck

The image bakes one healthcheck script (`docker-healthcheck.sh`) that probes the right endpoint for the container's `ETHOS_MODE`, so both Compose services and raw `docker run` users get a check that can actually pass.

| `ETHOS_MODE` | Probe | Serves |
|---|---|---|
| `all` (default) | `:3000/healthz` | web UI + supervised gateway |
| `ui` | `:3000/healthz` | web UI only |
| `gateway` | `:3002/healthz` | gateway's own health server |

A hardcoded `:3000` check could never pass in `gateway` mode — nothing listens there. The script fixes that.

Liveness is deliberate: only a definitive local failure flips a container unhealthy. A running process with an upstream outage (a Telegram blip, an adapter reporting not-ok) reports `degraded` over HTTP 503 but stays **healthy** — an upstream hiccup must not fail a fresh `compose up`. In `all` mode the check also fails if the supervised gateway's heartbeat goes stale or missing, which catches the gateway child dying while the web process stays up. This chains the existing gateway heartbeat — it is not a second health mechanism.

## Gateway opt-in

The channel gateway (Telegram, Slack, Discord, Email) is off by default. Activate it with the `gateway` profile:

```bash
ANTHROPIC_API_KEY=sk-ant-… docker compose -f docker/docker-compose.yml --profile gateway up
```

The gateway service connects to each configured channel bot and routes inbound messages to the appropriate personality. Configure channel bots in `config.yaml` inside the volume — see [config.yaml reference](../reference/config-yaml.md).

## Persisting data

The Compose file declares a named volume `ethos-data`, mounted at `/home/ethos/.ethos`. This volume holds `config.yaml`, the session database, personality data, and memory files.

The volume survives `docker compose down`. To back it up:

```bash
docker run --rm -v ethos-data:/data -v "$(pwd)":/backup alpine tar czf /backup/ethos-backup.tar.gz -C /data .
```

To restore:

```bash
docker run --rm -v ethos-data:/data -v "$(pwd)":/backup alpine tar xzf /backup/ethos-backup.tar.gz -C /data
```

:::warning
Do NOT run multiple containers sharing the same `ethos-data` volume. CronScheduler uses file-based locking and is not safe for concurrent multi-host access. `scale=1` per service is the only supported configuration. Running multiple replicas against the same volume will cause lock contention, data corruption, and undefined behaviour.
:::

## Advanced: custom config.yaml

To skip the init auto-generation, write your own `config.yaml` into the volume before the first run:

```bash
# Create the volume and populate it
docker volume create ethos-data
docker run --rm -v ethos-data:/data -v "$(pwd)":/src alpine cp /src/config.yaml /data/config.yaml
```

The `init` service is idempotent — it detects the existing config and exits immediately.

See [config.yaml reference](../reference/config-yaml.md) for every supported field.

## Advanced: manual docker run

If you prefer not to use Compose, run the image directly. Both services bind to `127.0.0.1` inside the container by default, so you must set `ETHOS_WEB_HOST=0.0.0.0` (web dashboard, port 3000) and `ETHOS_SERVE_HOST=0.0.0.0` (the `run-all` health server, port 3004) for `-p` to reach them from the host.

### Option A — run the published image (recommended)

```bash
docker run -d --name ethos \
  --restart unless-stopped \
  -e ETHOS_MANAGED=1 \
  -e ETHOS_WEB_HOST=0.0.0.0 \
  -e ETHOS_SERVE_HOST=0.0.0.0 \
  -e ANTHROPIC_API_KEY=sk-ant-… \
  -v ~/ethos-data:/home/ethos/.ethos \
  -p 3000:3000 \
  ethosagent/ethos:latest
```

`ethosagent/ethos:latest` always tracks the newest published release, so no version pinning is needed. To pin a specific version, use `ethosagent/ethos:<version>` (for example `ethosagent/ethos:0.4.18`).

### Option B — build from source then run

```bash
git clone https://github.com/ethosagent/ethos.git
cd ethos
docker build -t ethos:local -f docker/Dockerfile docker/
```

```bash
docker run -d --name ethos \
  --restart unless-stopped \
  -e ETHOS_MANAGED=1 \
  -e ETHOS_WEB_HOST=0.0.0.0 \
  -e ETHOS_SERVE_HOST=0.0.0.0 \
  -e ANTHROPIC_API_KEY=sk-ant-… \
  -v ~/ethos-data:/home/ethos/.ethos \
  -p 3000:3000 \
  ethos:local
```

The image runs as `ethos:1000` and exposes port 3000. `ETHOS_MANAGED=1` skips the interactive setup wizard and exits with code 2 if `config.yaml` is missing.

To run only the gateway (no web API), pass `-e ETHOS_MODE=gateway`. To run only the web API, pass `-e ETHOS_MODE=ui`.

## Kubernetes

The same pattern translates to a Deployment + ConfigMap (`config.yaml` and `mcp.json`) + Secret (`.env`) + PersistentVolumeClaim (session DB and personalities). Ethos does not ship a Helm chart today; the manifests below are the minimum a chart would template.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ethos-config
data:
  config.yaml: |
    schemaVersion: 1
    provider: anthropic
    model: claude-opus-4-7
    apiKey: ${secrets:providers/anthropic/apiKey}
    personality: researcher
    telegram.bots.0.token: ${secrets:channels/telegram/default/botToken}
    telegram.bots.0.bind.type: personality
    telegram.bots.0.bind.name: researcher
  mcp.json: |
    [{"name":"filesystem","transport":"stdio","command":"npx","args":["@modelcontextprotocol/server-filesystem","/data"]}]
---
apiVersion: v1
kind: Secret
metadata:
  name: ethos-secrets
type: Opaque
stringData:
  .env: |
    ANTHROPIC_API_KEY=sk-ant-...
    TELEGRAM_BOT_TOKEN=123:ABC...
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ethos
spec:
  replicas: 1
  selector: { matchLabels: { app: ethos } }
  template:
    metadata: { labels: { app: ethos } }
    spec:
      securityContext: { fsGroup: 1000 }
      containers:
        - name: ethos
          image: ethos:local
          env:
            - { name: ETHOS_MANAGED, value: "1" }
          ports: [{ containerPort: 3000 }]
          livenessProbe:
            httpGet: { path: /healthz, port: 3000 }
            initialDelaySeconds: 10
          volumeMounts:
            - { name: config,  mountPath: /home/ethos/.ethos/config.yaml, subPath: config.yaml }
            - { name: config,  mountPath: /home/ethos/.ethos/mcp.json,    subPath: mcp.json }
            - { name: secrets, mountPath: /home/ethos/.ethos/.env,        subPath: .env }
            - { name: state,   mountPath: /home/ethos/.ethos }
      volumes:
        - { name: config,  configMap: { name: ethos-config } }
        - { name: secrets, secret:    { secretName: ethos-secrets, defaultMode: 0o600 } }
        - { name: state,   persistentVolumeClaim: { claimName: ethos-state } }
```

Build the image with `docker build -t ethos:local -f docker/Dockerfile docker/` (note: `docker/Dockerfile`, not the old `apps/ethos/Dockerfile` path).

To wrap this as a Helm chart, move the per-environment values (provider, model, image tag, channel bot lists, MCP server list) into `values.yaml` and templatise the ConfigMap and Secret bodies.

## Troubleshoot

**Container exits with code 2.** `config.yaml` is missing from the mounted volume. Confirm the bind mount target is `/home/ethos/.ethos` and `config.yaml` is at the root of that directory.

**Healthcheck fails but logs show "gateway started".** The web API failed to bind. Check whether port 3000 is in use, or set `ETHOS_MODE=gateway` to skip the web API entirely.

**Telegram bot is silent.** Inspect `docker logs ethos` for adapter errors. The most common cause is a malformed token in `.env` — the value should have the form `<digits>:<base64-ish>` and the `botKey` suffix (if any) must match the one used in `config.yaml`.

**Permission denied writing to the volume.** The mounted host directory must be owned by uid 1000. `sudo chown -R 1000:1000 ~/ethos-data` fixes this.

## See also

- [Configure providers](configure-providers.md) — swap the LLM provider without restarting.
- [Run as a daemon](run-as-daemon.md) — systemd, launchd, and pm2 alternatives.
- [config.yaml reference](../reference/config-yaml.md) — every supported field.
- [MCP config reference](../reference/mcp-config.md) — transports, OAuth, env sandboxing.
