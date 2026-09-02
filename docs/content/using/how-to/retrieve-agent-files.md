---
title: "Retrieve files the agent wrote"
description: "Give a personality one or more working directories with fs_reach.workdir, then download or delete what it wrote from the Documents tab in the dashboard."
kind: how-to
audience: user
slug: retrieve-agent-files
time: "10 min"
updated: 2026-09-02
---

Ethos on a dedicated headless box usually runs under a service account nobody logs into. The agent writes reports, exports, and scratch files there — and the operator, working from a laptop with no shell on that account, has no way to reach them. Declaring a working directory turns those files into something a browser can list, download, and delete.

## Task

Give a [personality](../../getting-started/glossary.md#personality) (a directory of files that decides an agent's tools, memory, model, and filesystem reach) a dedicated working directory, and retrieve the files it writes there from a browser.

## Result

Files the agent writes with a bare relative path land in one known directory, and the **Documents** tab of the web dashboard lists them with per-file download and delete.

## Prereqs

- `ethos` installed and a provider configured ([Configure an LLM provider](configure-providers.md)).
- The web dashboard running and reachable ([Use the web dashboard](use-web-dashboard.md)).
- One way to declare the directory in step 1: shell access to `~/.ethos/personalities/<personality-id>/config.yaml`, or the dashboard's **Personalities** tab. Nothing after step 1 needs a shell.

## Steps

### 1. Declare the working directory

Add one line to the personality's `config.yaml`:

```yaml
# ~/.ethos/personalities/<personality-id>/config.yaml
fs_reach.workdir: ${ETHOS_HOME}/workspace/${self}
```

`${ETHOS_HOME}` resolves to `~/.ethos` and `${self}` to the personality id, so this personality gets `~/.ethos/workspace/<personality-id>`. A literal absolute path works too. See [`fs_reach.workdir`](../reference/personality-yaml.md#fs-reach-workdir) for the full token list and the rules on what is accepted.

The dotted key is the only accepted syntax. An indented `fs_reach:` block is refused at load.

To declare several directories, separate them with commas:

```yaml
fs_reach.workdir: ${ETHOS_HOME}/workspace/${self}, /srv/reports
```

Each entry becomes its own Documents root, with its own containment boundary. The first entry is also the agent's own working directory — the one bare relative paths resolve against. A second root is browsable and writable from Documents, but the agent's own file tools reach it only if it also appears in `fs_reach.read` / `fs_reach.write`.

To declare the directories without a shell, open **Personalities**, pick the personality, and fill **Working directories** under **Filesystem reach** on the **Config** tab. It is a tag field: type a path, press Enter, repeat. The dashboard writes the same comma-separated dotted key.

If the field is left empty, Documents is unconfigured for this personality — nothing is browsable and nothing is writable. There is no fallback to the directory the server was launched from.

### 2. Confirm the personality picked it up

```bash
ethos personality show <personality-id>
```

The **Filesystem reach** section of the character sheet gains a `Workdir` line:

```
## Filesystem reach
- (default — read: own directory, ~/.ethos/skills/, working directory; write: own directory, working directory)
- Workdir: ${ETHOS_HOME}/workspace/${self}
```

The character sheet prints the declared value, tokens and all — every entry, in declaration order. The resolved absolute paths appear in step 3.

The personality registry is mtime-cached and refreshed before each turn, so the next turn uses the new working directory. No restart.

### 3. Open the Documents tab

Start the dashboard, if it is not already up:

```bash
ethos serve --web
```

```
ethos web UI listening on http://localhost:3000
```

Open `http://localhost:3000/documents`, or pick **Documents** in the sidebar. Choose the personality from the dropdown in the page header. The resolved absolute root prints above the breadcrumb, and the table lists one row per entry:

| Column | What it shows |
|---|---|
| Name | File name. Directory names are buttons — click to descend. |
| Size | Byte size, human-formatted. `—` for directories. |
| Modified | Local `YYYY-MM-DD HH:MM`. |
| (actions) | **Download** and **Delete**, for files only. |

When the personality declares more than one working directory, a row of root tabs sits above the breadcrumb — one per declared entry, labelled by its last path segment. Switching roots resets the browsed path to that root's top level. A personality with one root gets no tabs: a picker with a single option cannot do anything, and the absolute path is already on screen.

Before the agent has written anything, the table reads:

```
Nothing in /home/ethos/.ethos/workspace/researcher yet. Files the agent writes with a relative path land here.
```

Ask the agent to write a file with a bare relative name (`write_file` with `report.md`, not `/tmp/report.md`), then reload the tab. The `terminal` tool also runs its commands here, under both the local and container execution postures.

The toolbar beside the root path carries **New folder** and **Upload**, for putting files in the other direction — see [Upload a file into the agent's folder](upload-agent-files.md).

### 4. Download a file

Click **Download** on a row. The browser fetches `GET /documents/download` and saves the file under its original name.

The link is authenticated by the dashboard's session cookie, so it works in any browser pointed at `ethos serve --web` — including through an SSH tunnel or a reverse proxy. It does **not** work in the desktop app's remote mode; see [Troubleshoot](#troubleshoot).

### 5. Delete a file

Click **Delete** and confirm. The file is removed from disk immediately — there is no trash tier and no undo from this surface. Directories have no **Delete** button at all: delete the files inside them individually.

## Verify

1. `ethos personality show <personality-id>` prints a `Workdir` line under **Filesystem reach**.
2. The Documents tab prints an absolute root that matches the declaration, with the substitutions resolved — one root tab per declared entry when there is more than one.
3. A file the agent wrote with a bare relative path appears in the listing, and downloading it yields the same bytes.

## Troubleshoot

### `<personality-id>` has no Documents folder configured

Cause · The personality declares no `fs_reach.workdir`, so Documents has no root. Every other Documents call refuses with `WORKDIR_NOT_CONFIGURED`. Nothing is rooted at the directory the server was launched from — that fallback was removed, so a directory the operator never declared can never be browsed or written to from this surface.

Fix ·
1. Declare the directory as in step 1, in `config.yaml` or in **Working directories** on the **Personalities** tab.
2. Reload the Documents tab. The registry refreshes before the call, so no restart is needed.

### The Documents tab lists nothing

Cause · The agent has not written anything yet, or it wrote to an absolute path somewhere else in its reach. The working directory only decides where *relative* paths land — an absolute path is used exactly as given.

Fix ·
1. Confirm the root printed above the breadcrumb is the directory you declared.
2. Ask the agent for a relative filename. An absolute path outside the personality's [fs_reach](../../getting-started/glossary.md#fs-reach) (its filesystem allowlist) is refused with a boundary error; one inside it writes there and stays invisible to this tab.

### `FS_REACH_INVALID` refuses the turn

Cause · The declared workdir uses a substitution token that resolves to an empty string. Rather than silently produce a path at the filesystem root, the turn is refused before it starts.

Fix ·
1. Read the error — it names the token and the template it appeared in.
2. Replace the token with a literal absolute path, or start the process from a directory where the token resolves.

### `Top-level key "fs_reach" cannot be a nested object in personality config`

Cause · `config.yaml` is a flat parser. `fs_reach` was written as an indented block.

Fix · Use the dotted form on one line: `fs_reach.workdir: /srv/ethos/out`.

### A row has no Download or Delete button

Cause · The entry is a directory or a symlink. Directories are never deletable from this surface, and symlinks are listed but never served — the link path sits inside the working directory while its target need not.

Fix · Descend into the directory and act on the files inside. For a symlink, retrieve the target through its own path.

### Download does nothing in the desktop app

Cause · Known limitation. The desktop app in remote mode authenticates with a bearer token injected at the Electron network layer, and a header cannot ride the top-level navigation a download link performs.

Fix · Open the same dashboard in a browser (`http://<host>:3000/documents`) and download from there. Local mode is unaffected.

### The workdir disappeared from `config.yaml`

Cause · The **Working directories** field was empty when the personality was saved from the **Personalities** tab. An empty field clears the declaration: the agent's own relative paths fall back to the process working directory, and Documents becomes unconfigured.

Fix ·
1. Open **Personalities**, pick the personality, and go to the **Config** tab.
2. Re-enter the paths in **Working directories** under **Filesystem reach**, then save.

Prevent · Editing any other field on that form leaves the working directories alone — the field round-trips its stored value.

## See also

- [Upload a file into the agent's folder](upload-agent-files.md) — the same tab, in the other direction.
- [`fs_reach.workdir`](../reference/personality-yaml.md#fs-reach-workdir) — the config field, its tokens, and how it widens the read/write allowlist.
- [Use the web dashboard](use-web-dashboard.md) — the rest of the dashboard's tabs.
- [Run Ethos as a daemon](run-as-daemon.md) — the headless deployment this page assumes.
- [Desktop app](../../platforms/desktop.md) — local versus remote mode.
