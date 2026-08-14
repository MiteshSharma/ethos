---
title: "Desktop app"
description: "The Ethos desktop app (Electron): native Mac, Windows, and Linux interface with local or remote server connectivity and OS keychain auth storage."
kind: reference
audience: shared
slug: platform-desktop
updated: 2026-08-14
---

The Ethos desktop app is an Electron shell that provides a native Mac, Windows, and Linux interface with the same [agent](../getting-started/glossary.md#agent) capabilities as the CLI and web dashboard. It runs in local mode (embedded server) or remote mode (connected to an external Ethos instance).

## Source {#source}

- `apps/desktop/src/main/index.ts` — Electron main process: window lifecycle and startup mode
- `apps/desktop/src/main/serve.ts` — embedded `web-api` process for local mode
- `apps/desktop/src/main/keychain.ts` — auth token storage via Electron `safeStorage`
- `apps/desktop/src/main/satellite.ts` — main-process wake-satellite host (see [Wake satellite](#wake-satellite))
- `apps/desktop/src/renderer/` — the web UI rendered inside the native window

## Synopsis {#synopsis}

The desktop app wraps the Ethos web UI in a native window. It provides:

- Full agent chat with streaming responses and [tool](../getting-started/glossary.md#tool) events
- Settings panel for [personality](../getting-started/glossary.md#personality), MCP server, and connection management
- Local mode with an embedded `web-api` process (no separate server required)
- Remote mode connecting to any running Ethos server instance
- Status bar indicator showing connection state

All [sessions](../getting-started/glossary.md#session) and [memory](../getting-started/glossary.md#memory) use the same `~/.ethos/` directory as the CLI.

## Installation {#installation}

Download the installer for your platform from the releases page.

| Platform | Format | Notes |
|---|---|---|
| macOS | `.dmg` | Universal binary (Intel + Apple Silicon). Drag to `/Applications`. |
| Windows | `.exe` installer | Standard Windows installer. Adds a Start Menu entry. |
| Linux | `.AppImage`, `.deb` | AppImage is portable; `.deb` integrates with apt. |

## Local mode {#local-mode}

Local mode is the default. The app starts an embedded `web-api` process, equivalent to running `ethos serve --web` from the CLI. No separate server installation is required.

Sessions are stored in `~/.ethos/` — the same directory the CLI uses. Switching between the desktop app and `ethos chat` from the same working directory shares conversation history through the standard [session](../getting-started/glossary.md#session) keying model.

## Remote mode {#remote-mode}

Connect to a remote Ethos server instead of running locally. The connection target is any running `ethos serve --web` or `ethos run-all` instance — a VPS, home server, or team deployment.

Configure the connection:

1. Open **Settings** → **Connection**.
2. Select **Remote**.
3. Enter the server URL and auth token.
4. Select **Test Connection** to verify.
5. Select **Save**.

```
┌─────────────────────────────────────┐
│  Connection Settings                │
├─────────────────────────────────────┤
│                                     │
│  Mode:  ○ Local   ● Remote          │
│                                     │
│  Server URL                         │
│  ┌─────────────────────────────────┐│
│  │ https://ethos.example.com       ││
│  └─────────────────────────────────┘│
│                                     │
│  Auth Token                         │
│  ┌─────────────────────────────────┐│
│  │ ••••••••••••••••••••            ││
│  └─────────────────────────────────┘│
│  Stored in OS keychain              │
│                                     │
│  [ Test Connection ]  [ Save ]      │
│                                     │
│  Status: ● Connected (142ms)        │
│                                     │
└─────────────────────────────────────┘
```

Known limitation: file download from the **Documents** tab does not work in remote mode. Remote mode authenticates with a bearer token injected at the Electron network layer, and a header cannot ride the top-level navigation a download link performs. Open the same server in a browser to download. Local mode is unaffected. See [Retrieve files the agent wrote](../using/how-to/retrieve-agent-files.md).

## Security {#security}

The auth token is stored in the OS keychain via Electron `safeStorage`. It is never written to config files or stored on disk in plaintext.

| Concern | Handling |
|---|---|
| Token storage | OS keychain (`safeStorage`) — encrypted at rest by the OS |
| Transport | HTTPS recommended for all remote connections |
| Token transmission | Sent only over the configured connection — not logged, not included in crash reports |

## Status bar indicator {#status-bar}

The status bar shows the current connection state.

| Indicator | Meaning |
|---|---|
| Green dot — "Local" | Running the embedded `web-api` process |
| Blue dot — "Remote: *hostname*" | Connected to a remote server |
| Red dot — "Disconnected" | Connection lost; the app is attempting to reconnect |

## Wake satellite {#wake-satellite}

The Electron main process hosts a [wake satellite](../getting-started/glossary.md#wake-satellite) against the app's own embedded backend, with a tray indicator and a wake-enabled state persisted across restarts.

**It cannot listen or speak today.** The main process ships no microphone binding, so the satellite's preflight adds a failing `capture-device` probe, the host reports `degraded`, and nothing starts:

```
no capture device configured — the Electron main process ships no microphone binding,
so this host cannot listen. Run `ethos listen` on a machine with one, or inject a
CaptureDevice into startSatellite().
```

That refusal is deliberate. Connecting the lane and showing a green dot over a microphone that never produces a frame is the indicator lie the whole satellite lane exists to prevent.

Everything downstream of the device is wired: the doctor-gated start, the supervised capture machine, the node protocol, wake → utterance uplink, and re-arm on `turn_end`. A capture module becomes one argument to `startSatellite`, not a rewrite. To run a satellite today, use [`ethos listen`](../using/how-to/run-a-wake-satellite.md) on a machine where you can pipe a microphone in.

## Switching between local and remote {#switching-modes}

Open **Settings** → **Connection** and toggle between **Local** and **Remote**. Switching modes restarts the agent [session](../getting-started/glossary.md#session).

```mermaid
graph LR
    A[Desktop App] --> B{Mode}
    B -->|Local| C[Embedded web-api]
    B -->|Remote| D[HTTPS] --> E[Remote Ethos Server]
```

## See also {#see-also}

- [CLI platform](cli.md) — the terminal surface that shares the same `~/.ethos/` state directory.
- [Configure providers](../using/how-to/configure-providers.md) — provider chain and key rotation shared across all surfaces.
- [Glossary](../getting-started/glossary.md) — [`session`](../getting-started/glossary.md#session), [`personality`](../getting-started/glossary.md#personality), [`agent`](../getting-started/glossary.md#agent).
