---
title: "Use the web dashboard"
description: "Start the Ethos web dashboard, manage personalities, browse memory, schedule cron jobs, and handle MCP OAuth — all from the browser."
kind: how-to
audience: user
slug: use-web-dashboard
time: "10 min"
updated: 2026-08-08
---

## Task

Use the web dashboard as a first-class management surface alongside the CLI for managing [personalities](../../getting-started/glossary.md#personality), [memory](../../getting-started/glossary.md#memory), cron jobs, and MCP servers.

## Result

A running dashboard at `http://localhost:3000` where you can create and edit personalities, browse memory, manage cron jobs, and handle MCP OAuth flows — all from the browser.

## Prereqs

- `ethos` installed and a provider configured ([Configure an LLM provider](configure-providers.md)).
- A modern browser (Chrome, Firefox, Safari, Edge).
- For remote access: an SSH tunnel or reverse proxy to the host running `ethos serve`.

## Steps

### 1. Start the dashboard

```bash
ethos serve --web
```

The dashboard starts on port 3000 by default. To use a different port:

```bash
ethos serve --web --port 8080
```

For remote machines, open an SSH tunnel:

```bash
ssh -L 3000:localhost:3000 user@remote-host
```

Then open `http://localhost:3000` in your local browser.

### 2. Navigate the main tabs

The sidebar shows eight tabs:

| Tab | Purpose |
|---|---|
| **Chat** | Interactive chat with the active personality. |
| **Personalities** | Create, edit, and inspect personality configurations. |
| **Memory** | Browse and search personality memory (`MEMORY.md`) and user memory (`USER.md`). |
| **Documents** | Browse, download, and delete the files a personality wrote in its working directory. See [Retrieve files the agent wrote](retrieve-agent-files.md). |
| **Cron** | View, manage, and test scheduled jobs. |
| **MCP** | Add MCP servers, handle OAuth, manage tokens. |
| **Dashboards** | View plugin data sources as customizable widget panels. |
| **Admin** | Manage channels, API keys, and MCP server connections. |

### 3. Create a personality via the wizard

Navigate to the **Personalities** tab and click **Create Personality**. The wizard walks through seven steps:

**Step 1 — Basics.** Set the personality ID (lowercase, hyphens allowed), display name, and description. The ID becomes the directory name under `~/.ethos/personalities/`.

**Step 2 — Soul.** Write or paste the `SOUL.md` content. This is the first-person identity document — who the personality is, how it speaks, what it values. The editor supports markdown preview.

**Step 3 — Config.** Set the model (`claude-sonnet-4-20250514`, `gpt-4o`, etc.), memory scope, and optional overrides like `temperature` and `maxTokens`. These map to fields in `config.yaml`.

**Step 4 — Toolset.** Select which tools the personality can access. The checklist groups tools by category (file, terminal, web, memory, cron). Each selected tool is written to `toolset.yaml`.

**Step 5 — Skills.** Attach skills from the discovered skill library. The list comes from `ethos skills list` — skills installed via ClawHub, Claude Code, or the local `~/.ethos/skills/` directory.

**Step 6 — MCP.** Attach MCP servers from the registered list in `mcp.json`. If a server requires OAuth, the wizard prompts you to authenticate now (the token is stored at the per-personality path). See [Set up MCP for a personality](set-up-mcp-for-a-personality.md) for the full flow.

**Step 7 — Plugins.** Attach plugins from `~/.ethos/plugins/`. This step is optional — most personalities don't need plugins.

Click **Create** to write the personality to disk. The personality registry picks it up on the next turn (mtime-cached, no restart needed).

### 4. Edit a personality

Click a personality card in the **Personalities** tab to open its detail view. Each section (Soul, Config, Toolset, Skills, MCP, Plugins) is editable inline. Changes write directly to the corresponding file under `~/.ethos/personalities/<id>/`.

The **Character Sheet** panel on the right renders the same output as `ethos personality show <id>` — identity, routing, memory scope, toolset, MCP servers, and plugins.

### 5. Browse memory

Navigate to the **Memory** tab. Two independent dropdowns control what you see:

- **Personality dropdown** — select a personality to browse its `MEMORY.md`. This is the rolling project context updated each session.
- **User dropdown** — select a user profile to browse `USER.md`. This is the persistent cross-session, cross-personality user profile.

The memory viewer renders markdown with syntax highlighting. Use the search bar to find entries across the selected memory file.

### 6. Manage cron jobs

Navigate to the **Cron** tab. The table lists all scheduled jobs across all personalities.

| Column | Content |
|---|---|
| **Name** | Human-readable job label. |
| **Personality** | The personality the job runs under. |
| **Schedule** | Cron expression (e.g. `0 8 * * 1-5`). |
| **Status** | `active` or `paused`. |
| **Next run** | Timestamp of the next scheduled firing. |
| **Last run** | Timestamp and status of the most recent execution. |

Actions available per job:

- **Run now** — fire the job immediately, outside its schedule.
- **Pause / Resume** — toggle the job's active state.
- **View history** — expand to see past runs with timestamps and output.
- **Remove** — permanently delete the job.

To create a new job, use the chat interface — the cron tool is agent-callable, not form-driven. See [Schedule tasks with cron](schedule-tasks-with-cron.md) for the full workflow.

### 7. Add and manage MCP servers

Navigate to the **MCP** tab. Click **Add MCP Server** to register a new server.

For OAuth-protected servers:

1. Enter the server URL (e.g. `https://mcp.linear.app`).
2. The UI runs OAuth discovery and displays the server's metadata.
3. Select a personality from the dropdown — the token will be stored under this personality's path.
4. Click **Connect** to start the PKCE flow in a new tab.
5. After authorising, the token lands at `~/.ethos/personalities/<id>/mcp/<name>/`.

For stdio or bearer-token servers, the form collects the command, args, and headers. No OAuth flow is needed.

The MCP tab also shows:

- **Connection status** per server per personality.
- **Token expiry** for OAuth-authenticated servers.
- A **Disconnect** button that revokes the token and removes the stored credential.

### 8. Chat with a personality

Navigate to the **Chat** tab. Select a personality from the dropdown at the top. Type a message and press Enter.

The chat view streams the agent's response in real time, showing tool calls inline with expandable detail panels. Each tool call shows the tool name, arguments, and result. Slash commands work the same as in the CLI:

| Command | Effect |
|---|---|
| `/personality <id>` | Switch to a different personality mid-session. |
| `/new` | Start a fresh session (clears conversation history). |
| `/skills` | List skills the active personality can access. |
| `/memory` | Show the active personality's memory summary. |

The session persists across page reloads — the dashboard reads from the same `SessionStore` the CLI uses. Starting a `/new` session in the dashboard is visible to `ethos chat` and vice versa.

### 9. Remote access

The dashboard binds to `localhost` by default. For remote access, use an SSH tunnel rather than exposing the port directly:

```bash
# On your local machine
ssh -L 3000:localhost:3000 user@remote-host
```

Then open `http://localhost:3000` locally. The tunnel forwards all traffic securely.

For production deployments behind a reverse proxy (nginx, Caddy), point the proxy at `localhost:3000` on the host. The dashboard serves all assets from a single origin — no CORS configuration is needed. See [Deploy in production](deploy-in-production.md) for the full reverse-proxy setup.

The dashboard does not implement its own authentication. Access control relies on the network boundary (SSH tunnel, VPN, or reverse proxy with auth). Do not expose port 3000 to the public internet without an authentication layer in front.

### 10. Use dashboards

Dashboards display data from plugin data sources as customizable panels.

Navigate to the **Dashboards** tab.

Click **Add widget** to see available widget templates. Plugins that ship a `widgets.yaml` contribute pre-built panels — each shows a title, description, and plugin badge. Click a template to create a panel pre-filled with the template's SQL query.

The dashboard runs read-only SQL against plugin-registered SQLite databases. Mutating queries (`INSERT`, `UPDATE`, `DELETE`, `DROP`) are rejected with a `READONLY_QUERY_ONLY` error.

### 11. Navigate the admin panel

Navigate to `/admin` for operational management. The admin panel has three tabs:

- **Channels** — view configured channel adapter status and webhook URLs.
- **API Keys** — check LLM provider health and rotate API keys.
- **MCP Servers** — add or remove MCP server connections.

For the full walkthrough, see [Use the admin panel](use-admin-panel.md).

### 12. Review skill proposals

When the skill evolver proposes a new skill, a badge appears in the status bar.

Click the badge to open the proposals panel. Each proposal shows the skill name, when it was proposed, and a preview of the content. Approve to activate the skill; reject to delete it.

For the full workflow, see [Manage skill evolution](manage-skill-evolution.md).

### 13. Handle background notifications

When a background process completes, a notification appears inline in the chat. Failed processes include the last 1000 characters of stderr.

If you're offline when a process completes, the notification is buffered and delivered when you next open a session.

## Verify

Open `http://localhost:3000` in your browser. The dashboard loads with the sidebar tabs visible. Click **Personalities** — your existing personalities appear as cards. If you created a personality via the wizard, `ethos personality list` in a separate terminal shows the same roster.

## Troubleshoot

**Dashboard doesn't load at `localhost:3000`** — Verify `ethos serve --web` is running. Check the terminal for errors. If port 3000 is in use, specify a different port with `--port`.

**Personalities tab is empty** — No personalities exist yet. Create one with the wizard or from the CLI:

```bash
ethos personality create engineer
```

**Memory tab shows "No content"** — The selected personality or user has no memory yet. Start a chat session and the agent populates `MEMORY.md` after the first turn.

**Cron tab shows no jobs** — No cron jobs have been created. Use the chat interface to create one — see [Schedule tasks with cron](schedule-tasks-with-cron.md).

**MCP OAuth redirect fails** — The browser cannot reach the OAuth provider's authorization endpoint. Check your network connection. If running remotely via SSH tunnel, ensure the tunnel forwards the callback port as well.

**Changes made in the dashboard don't appear in CLI** — The dashboard writes to the same `~/.ethos/` directory the CLI reads. Changes should appear immediately. If they don't, the personality registry's mtime cache may not have refreshed — run any `ethos` command to trigger a reload.

**Dashboard is slow on first load** — The web assets are served from the `ethos serve` process. The first load compiles and bundles the frontend. Subsequent loads are cached.

## See also

- [Set up MCP for a personality](set-up-mcp-for-a-personality.md) — detailed MCP OAuth walkthrough for both web and CLI paths.
- [Schedule tasks with cron](schedule-tasks-with-cron.md) — create and manage cron jobs via the agent.
- [Run Ethos as a daemon](run-as-daemon.md) — run `ethos serve` as a persistent background process.
- [Deploy in production](deploy-in-production.md) — full production setup with gateway, web dashboard, and PM2.
- [CLI reference](../reference/cli.md) — the CLI equivalents of every dashboard action.
- [Personality config](../reference/personality-yaml.md) — the file format behind the wizard's Config step.
- [Use the admin panel](use-admin-panel.md) — manage channels, keys, and MCP servers.
- [Manage skill evolution](manage-skill-evolution.md) — review and approve auto-proposed skills.
