---
title: "Upload a file into the agent's folder"
description: "Create folders and upload any local file into a personality's Documents root from the web dashboard, with a 100 MB cap and opt-in overwrite."
kind: how-to
audience: user
slug: upload-agent-files
time: "5 min"
updated: 2026-09-02
---

Handing an agent a file on a headless box used to mean finding a shell, an `scp` command, and the right absolute path. The **Documents** tab does it from a browser: pick the folder, pick the file, upload. The agent reads it on the next turn under a bare relative name.

## Task

Put a local file — any type — into the Documents folder of a [personality](../../getting-started/glossary.md#personality) (a directory of files that decides an agent's tools, memory, model, and filesystem reach), creating the destination folder if it does not exist yet.

## Result

The file sits in the personality's working directory on the server, listed in the **Documents** tab, and reachable by the agent's `read_file` with a relative path.

## Prereqs

- The web dashboard running and reachable ([Use the web dashboard](use-web-dashboard.md)).
- A personality with at least one `fs_reach.workdir` declared ([Retrieve files the agent wrote, step 1](retrieve-agent-files.md#1-declare-the-working-directory)). Without one, Documents is unconfigured and there is nowhere to upload to.

## Steps

### 1. Open Documents and pick the root

```bash
ethos serve --web
```

```
ethos web UI listening on http://localhost:3000
```

Open `http://localhost:3000/documents` and choose the personality in the page header. The resolved absolute root prints above the breadcrumb.

If the personality declares more than one working directory, pick which one you are uploading into from the root tabs above the breadcrumb. The upload lands in the selected root — the destination picker in step 3 never spans roots.

### 2. Create the destination folder

Skip this step to upload into a folder that already exists.

Click **New folder**, type a name, and confirm. The folder appears in the listing immediately:

```
research/    —    2026-09-02 14:31
```

One level at a time: the folder is created inside the folder you are currently browsing, and a name containing `/` is refused. To build `research/2026/`, create `research`, descend into it, then create `2026`.

### 3. Upload the file

Click **Upload**. The modal takes four things:

| Field | What it does |
|---|---|
| File | A native file picker. One file per upload — the route takes one raw body per request. |
| Destination folder | Where the file lands, relative to the selected root. Defaults to the folder you were browsing. |
| New folder here | Creates a folder inside the current destination and moves the destination into it. |
| Filename | Defaults to the picked file's name. Edit it to store the file under a different name. |

The line under the fields shows the exact path the file will take:

```
Uploads to research/2026/rates.csv
```

Click **Upload**. On success the modal closes and a notification names the path:

```
Uploaded research/2026/rates.csv
```

No MIME check runs — a CSV, a PDF, a zip, and a zero-byte file are all accepted. The cap is 100 MB per file.

### 4. Replace a file that already exists

An upload never clobbers silently. If the destination already holds a file with that name, the modal refuses and explains:

```
A file with that name already exists in this folder.
```

To overwrite it deliberately, click **Replace existing file** — the button appears next to **Upload** only after that refusal. To keep both, edit the **Filename** field instead and upload again.

### 5. Let the agent read it

The file is on disk under the personality's working directory, so a bare relative path reaches it. Open a chat with that personality — the dashboard's **Chat** tab, or `ethos chat` and [`/personality <personality-id>`](../reference/slash-commands.md#slash-personality) — and name the path:

```
You > summarize research/2026/rates.csv

240 rows covering Jan–Aug 2026. The median rate is 4.1%…
```

## Verify

1. The uploaded file appears in the **Documents** listing at the destination folder, with a non-zero size and today's **Modified** timestamp.
2. **Download** on that row returns the same bytes you uploaded.
3. The agent reads it by relative path in a chat turn.

## Troubleshoot

### The parent folder does not exist

Cause · The destination folder was deleted or renamed between opening the modal and submitting. Upload creates no directories — it writes one file into a folder that already exists.

Fix · Create the folder with **New folder here** in the modal, then upload again.

### `DOCUMENT_EXISTS` on a folder you just created

Cause · Something already sits at that path — a file, not only a folder. **New folder** refuses any occupied path rather than merging into it.

Fix · Pick a different folder name, or delete the file occupying the name first.

### `PAYLOAD_TOO_LARGE`

Cause · The file is over the 100 MB per-upload cap. The cap is enforced while the body is read, so an oversized file is refused whether or not the browser declared its length up front.

Fix · Split or compress the file, or move it onto the server by another route (`scp`, a mounted volume) into the same working directory — Documents lists whatever is there, however it arrived.

### `WORKDIR_NOT_CONFIGURED`

Cause · The personality declares no `fs_reach.workdir`, so there is no root to upload into. There is no fallback to the directory the server was launched from.

Fix · Declare one — see [Retrieve files the agent wrote, step 1](retrieve-agent-files.md#1-declare-the-working-directory).

### The agent cannot read a file you uploaded to a second root

Cause · Only the **first** declared `fs_reach.workdir` entry is added to the personality's read and write allowlist. Documents browses every declared root; the agent's own file tools do not.

Fix · Add that root to [`fs_reach.read`](../reference/personality-yaml.md#fs-reach) (and `fs_reach.write` if the agent should write there), or upload into the first root instead.

## See also

- [Retrieve files the agent wrote](retrieve-agent-files.md) — the same tab, in the other direction.
- [`fs_reach.workdir`](../reference/personality-yaml.md#fs-reach-workdir) — declaring one root or several.
- [Use the web dashboard](use-web-dashboard.md) — the rest of the dashboard's tabs.
- [Troubleshooting](../../troubleshooting.md#error-reference) — every error code in one table.
