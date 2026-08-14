---
title: "Receive files via Telegram"
description: "Configure your Telegram bot to ingest photos, documents, and voice messages from users."
kind: how-to
audience: user
slug: receive-files-via-telegram
time: "5 min"
updated: 2026-08-14
---

## Task

Accept photos and documents from Telegram users so the agent can read, analyze, or process them.

## Result

Users send a photo or document to the bot. The agent sees an `<attachments>` block in the message and can call tools like `vision_analyze` or `read_file` to work with the file.

## Prereqs

- A working Telegram bot connected to Ethos (see the [Telegram platform guide](../../platforms/telegram.md)).
- At least one personality with `vision_analyze` or `read_file` in its `toolset.yaml`.

## Steps

### 1. No special configuration needed

The Telegram adapter handles photos and documents automatically. When a user sends a photo or attaches a document, the adapter downloads the file, caches it locally, and includes it in the message delivered to the agent. No config changes are required beyond a working bot.

### 2. Verify the personality has attachment-capable tools

The agent needs tools that declare the `attachments` capability to use the files. Check your personality's `toolset.yaml`:

```yaml
# ~/.ethos/personalities/<id>/toolset.yaml
- read_file        # reads attached documents via ref argument
- vision_analyze   # analyzes attached images via ref argument
```

Without these tools (or custom tools declaring `capabilities.attachments`), the agent sees the `<attachments>` block but cannot open the files.

### 3. Send a file and observe

1. Open a chat with your bot in Telegram.
2. Send a photo or attach a document (PDF, text file, CSV, etc.).
3. Add a caption like "What is in this file?" or send the file without text.
4. The agent sees the attachment metadata and calls the appropriate tool.

When no text accompanies the file, the adapter surfaces `(attached image)` or `(attached file)` as the message text so the agent has context.

## Verify

- The bot replies referencing the file's contents (not just the filename or caption).
- The agent's response includes output from the attachment-aware tool (`vision_analyze` for photos, `read_file` for documents).
- No "File too large" suffix appears in the inbound message (indicates the file exceeded the 25 MB cap — see Limits).

## Supported types

| Type | Telegram media field | Attachment type | Notes |
|---|---|---|---|
| Photos | `photo` | `image` | The adapter picks the highest-resolution variant. MIME type is always `image/jpeg` (Telegram compresses photos). |
| Documents | `document` | `file` | PDFs, text files, spreadsheets, images sent as documents. MIME type comes from Telegram's detection. |
| Voice messages | `voice` | `audio` | Ogg/Opus. Transcribed by the gateway's speech-to-text stage; the transcript is appended to the turn text. |
| Audio files | `audio` | `audio` | Forwarded music, MP3 uploads. Same transcription path as voice messages. |

Audio needs an STT provider configured — see [Send and receive voice notes on a channel](voice-notes-on-channels.md). Without one, the upload still reaches the agent as an audio marker with no transcript.

## Not supported yet

Video, animations (GIFs), and stickers are intentionally dropped. The inbound caption still reaches the agent, but no attachment is created. These types are deferred until media analysis tools ship.

## Limits

- **Size cap: 25 MB per file.** Files exceeding this limit are skipped. The adapter appends "(File too large -- 25 MB limit)" to the message text so the user knows.
- **Telegram Bot API limit: 20 MB for `getFile`.** Telegram's Bot API caps `getFile` downloads at 20 MB. Files between 20-25 MB may fail at the Telegram API level even though the adapter's cap is higher.
- **No special permissions required.** The bot needs only the standard message permission granted at creation. No additional BotFather settings are needed for file ingestion.

## How it works

1. User sends a photo, document, or voice message to the bot.
2. The adapter calls `bot.api.getFile(fileId)` to get the download URL.
3. The adapter downloads the file from `https://api.telegram.org/file/bot<token>/<file_path>`.
4. The file is written to the `AttachmentCache` at `~/.ethos/cache/attachments/`.
5. The `InboundMessage` carries an `attachments` array with `type`, `ref`, `url` (a `file://` path), `mimeType`, and optional `filename` and `sizeBytes`.
6. `buildAttachmentAnnotation()` prepends an `<attachments>` XML block to the user's text.
7. The LLM sees the block and can call `vision_analyze` or `read_file` with the `ref` argument (e.g. `ref: "att-0"`).

## Troubleshoot

**Agent ignores the attached file.** -- Check that the personality's `toolset.yaml` includes `vision_analyze` (for images) or `read_file` (for documents). Without attachment-capable tools, the agent cannot open the file.

**"File too large" appended to message.** -- The file exceeds the 25 MB adapter cap or the 20 MB Telegram API cap. Compress or resize the file before sending.

**Photo quality is low.** -- Telegram compresses photos by default. To send at original quality, attach the image as a **document** (tap the paperclip, choose "File" instead of "Gallery"). The adapter creates a `file` type attachment with the original resolution.
