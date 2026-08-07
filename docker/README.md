# Running Ethos with Docker

The quickest way to run Ethos on any machine — no Node.js required.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Mac / Windows / Linux)

## Setup

### 1. Copy the example config

```bash
cd docker
cp .env.example .env
```

### 2. Fill in your credentials

Open `docker/.env` and set your values. The full reference is below.

### 3. Start

```bash
docker compose up
```

The web UI will be available at **http://localhost:3000**.

To stop: `docker compose down`

---

## Environment variable reference

### Provider (pick one — first found wins)

| Variable | Description |
|---|---|
| `AZURE_API_KEY` | Azure OpenAI API key |
| `ANTHROPIC_API_KEY` | Anthropic (Claude) API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `GOOGLE_API_KEY` | Google (Gemini) API key |

**Azure requires three extra vars:**

| Variable | Default | Description |
|---|---|---|
| `AZURE_ENDPOINT` | — | Your Azure OpenAI endpoint, e.g. `https://my-resource.openai.azure.com` |
| `AZURE_MODEL` | `gpt-4o` | Deployment name |
| `AZURE_API_VERSION` | `2024-12-01-preview` | API version |

**OpenRouter requires one extra var:**

| Variable | Default | Description |
|---|---|---|
| `OPENROUTER_MODEL` | — | Model to use, e.g. `openai/gpt-4o` or `anthropic/claude-3-5-sonnet` |

### Telegram bot (optional)

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token from [@BotFather](https://t.me/BotFather) — create a bot and copy the token |
| `TELEGRAM_OWNER_ID` | Your Telegram user ID — message [@userinfobot](https://t.me/userinfobot) to get it. **Required when `TELEGRAM_BOT_TOKEN` is set** — prevents unauthorized access to your bot |

### Storage

| Variable | Default | Description |
|---|---|---|
| `ETHOS_DATA_DIR` | `../ethos-data` | Where on **your machine** Ethos stores its state (config, secrets, sessions). Can be an absolute path or relative to the `docker/` folder. |
| `ETHOS_WORKSPACE_DIR` | `../ethos-workspace` | Where on **your machine** the agent's working directory lives — files it creates in `cwd` land here and survive restarts. Same path rules as `ETHOS_DATA_DIR`. |

### Agent

| Variable | Default | Description |
|---|---|---|
| `ETHOS_PERSONALITY` | `researcher` | Which personality the agent runs as. Run `ethos personality list` to see all options. |

---

## Fresh start / troubleshooting

If something is broken or you want to start completely clean, delete the state directory and restart:

```bash
# From the docker/ folder
rm -rf ../ethos-data          # or wherever ETHOS_DATA_DIR points
docker compose down
docker compose up
```

The `init` container will recreate `config.yaml` and all secrets from your `.env` on the next run.

---

## How it works

Three containers start in order:

| Service | Role |
|---|---|
| `init` | One-shot bootstrap — reads your credentials from env, writes `config.yaml` and secrets to `ETHOS_DATA_DIR`. Exits immediately if config already exists. |
| `ethos-web` | Web UI on port 3000. Starts after `init` completes. |
| `ethos-gateway` | Channel gateway (Telegram, Slack, Discord). Starts after `init` completes. |
