---
title: Monitor Ethos with Prometheus and Grafana
description: Run a local Prometheus + Grafana stack against Ethos's /metrics endpoints and open the shipped observability dashboard.
kind: how-to
audience: user
slug: monitor-with-grafana
time: "15 min"
updated: 2026-08-20
---

## Task

Scrape Ethos's `/metrics` endpoints with Prometheus and open the pre-built Grafana dashboard for spend, tokens, tool latency, and adapter health.

## Result

A local Prometheus + Grafana stack, running in Docker, with both Ethos scrape targets reporting up and the **Ethos Observability** dashboard loaded and rendering — no manual JSON import, no hand-wired datasource.

## Prereqs

- Docker with Compose v2 (`docker compose`, not the legacy `docker-compose` binary).
- Ethos running with an [API key](../reference/config-yaml.md) store wired — `ethos serve` or `ethos gateway` started at least once so `sessions.db` exists. `/metrics` stays unmounted on a deployment with no API-key store.
- A [gateway](../../getting-started/glossary.md#gateway) (the process that runs every channel adapter) and/or `ethos serve` reachable from the machine running Docker.

## 1. Create a `metrics:read` API key

Prometheus authenticates to web-api's `/metrics` with a bearer token scoped to `metrics:read`. Mint one with the CLI:

```bash
ethos api-key create --name grafana --scopes metrics:read
```

```
✓ API key created  name: grafana

  sk-ethos-9f2c1a7b...redacted...

  prefix: sk-ethos-9f2c1a7b
  scopes: metrics:read

  This is the only time the full key is shown. Save it now.
```

Copy the printed secret — it is shown once. There is no separate mechanism for the gateway health server's `/metrics`: it authenticates with the same `metrics:read` key store as web-api's (`apps/ethos/src/health-server.ts`).

## 2. Configure the stack

The compose files live under `deploy/grafana/` in the repo. Copy the token placeholder and paste in the secret from step 1:

```bash
cd deploy/grafana
cp metrics-token.example metrics-token
$EDITOR metrics-token   # replace the placeholder line with your real key
```

`metrics-token` is gitignored — it never gets committed.

## 3. Bring up Prometheus and Grafana

```bash
docker compose up -d
```

```
[+] Running 2/2
 ✔ Container grafana-prometheus-1  Started
 ✔ Container grafana-grafana-1     Started
```

This starts two containers only — Prometheus and Grafana. It does not run Ethos. `prometheus.yml` targets `host.docker.internal:3000` (web-api) and `host.docker.internal:3002` (gateway health), reaching whatever Ethos process is already running on the host.

The gateway health server binds to `127.0.0.1` by default, which a Prometheus container cannot reach as-is. Pick one:

- **Rebind it.** Set `ETHOS_SERVE_HOST=0.0.0.0` on the gateway process and publish port `3002`. This deliberately exposes the endpoint beyond loopback — `metrics:read` still gates it (the gateway process always wires an API-key store), but only do this on a trusted network.
- **Share the host network namespace instead** (Linux only): swap the `prometheus` service in `docker-compose.yml` to `network_mode: host`, dropping the `ports:` and `extra_hosts:` entries. It then reaches `127.0.0.1:3002` directly, with no rebind needed.

If you only run `ethos serve` (no gateway), the `ethos-gateway-health` job just stays down — the web-api job alone is enough.

## 4. Confirm both scrape targets are up

```bash
open http://localhost:9090/targets
```

Look for `ethos-web-api` and `ethos-gateway-health`, both `State: UP`. A target that never turns up green means Prometheus can't reach the port — recheck [step 3](#3-bring-up-prometheus-and-grafana), or confirm the process (`ethos serve` / `ethos gateway`) is actually running.

## 5. Open the dashboard

```bash
open http://localhost:3300
```

Log in with `admin` / `admin` (Grafana prompts you to change it on first login). The **Ethos Observability** dashboard is already provisioned under the **Ethos** folder — no JSON import step. Panels resolve their Prometheus datasource through a `${DS_PROMETHEUS}` template variable at the top of the dashboard, so the same JSON also imports cleanly through Grafana's UI (**Dashboards → New → Import**) against any Prometheus datasource you already run, on-call or off.

## Verify

- `/targets` shows both jobs `UP` (or `ethos-web-api` alone, if you run no gateway).
- The dashboard's **Spend over time** and **Tokens by personality/model** panels show data once a turn has run through Ethos since Prometheus started scraping (metrics are counters — an idle process shows flat lines, not errors).
- The **Adapter health** panel shows one row per configured channel adapter, green when up.

## Read the caveat panel before trusting a number

The dashboard's bottom-right panel states two things worth repeating here, because they are easy to miss on a first read:

1. **Prometheus spend is span-derived; `ethos usage` (the CLI) is message-derived.** They read different tables and can diverge — never treat them as the same number.
2. **The `openai-compat` transport (OpenRouter, Ollama, Gemini-via-compat, Anthropic-via-compat) always reports `cacheReadTokens=0` in this phase.** Any model routed through it undercounts on the **Cache-hit rate** panel and understates cache-driven cost savings on **Spend over time**. This is a known limitation of the current phase, not a bug to file.

## Troubleshoot

**Prometheus target `ethos-web-api` is down with a connection refused.**
`ethos serve` isn't running, or port 3000 isn't the one it's bound to. Confirm with `curl -s http://localhost:3000/healthz` on the host.

**Target is down with `401 Unauthorized`.**
`metrics-token` doesn't hold a valid `metrics:read` key, or you copied the placeholder line instead of the real secret. Re-run [step 1](#1-create-a-metricsread-api-key) and re-check `metrics-token`'s contents — no trailing newline issues, just the raw key on its own line.

**Target `ethos-gateway-health` never turns up, and you don't run a gateway.**
Expected — that job has nothing to scrape. It's not an error; the dashboard's adapter-health panel is simply empty.

**Dashboard panels show "Datasource prometheus was not found."**
The `${DS_PROMETHEUS}` variable didn't resolve to the provisioned datasource. Confirm `docker compose ps` shows both containers running, then check **Connections → Data sources** in Grafana for a datasource named `Prometheus` with UID `prometheus` — `provisioning/datasources/prometheus.yml` sets that UID explicitly so the dashboard's default resolves without picking from a dropdown.

## Tear down

```bash
docker compose down -v
```

This removes both containers and their volumes (scraped history, Grafana's own DB). `metrics-token` and your Ethos deployment are untouched.

## See also

- [Config reference](../reference/config-yaml.md) — API-key store wiring.
- [Run Ethos in Docker](run-in-docker.md) — the three-service compose topology this stack scrapes into, if you run Ethos itself in containers too.
