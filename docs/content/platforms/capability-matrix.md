---
title: "Channel capability matrix"
description: "What each Ethos channel adapter supports: typing, streaming edits, media, voice notes, threads, reactions, and how the gateway degrades when one is absent."
kind: reference
audience: shared
slug: channel-capability-matrix
updated: 2026-08-14
---

Not every channel supports every feature. Telegram edits messages in place; email cannot. Slack uploads files; WhatsApp does not. The gateway reads each adapter's declared capabilities and degrades gracefully — a streamed reply falls back to a single message where edits are unavailable, and outbound media falls back to text where uploads are unsupported. This page is the authoritative lookup for what each adapter supports today.

Each capability is declared on the adapter itself (the `canSendTyping` / `canEditMessage` / `canReact` / `canSendFiles` flags and the `capabilities` manifest), so this table tracks source, not aspiration.

## Support matrix {#matrix}

| Capability | Telegram | Slack | Discord | WhatsApp | Email |
|---|---|---|---|---|---|
| Typing indicator | ✓ | ✓ (probed) | ✓ | ✗ | ✗ |
| Streaming draft edits | ✓ | ✓ | ✓ | ✗ | ✗ |
| Message edit (`editMessage`) | ✓ | ✓ | ✓ | ✗ | ✗ |
| Inbound media | ✓ | ✓ | ✓ | ✓ | ✗ |
| Outbound media | ✓ | ✓ | ✗ | ✗ | ✗ |
| Reactions | ✓ | ✓ | ✓ | ✓ | ✗ |
| Threads / topics | ✓ (forum topics) | ✓ (`thread_ts`) | ✓ | ✗ | ✗ |
| Reply-to a message | ✓ | ✗ | ✗ | ✓ | ✗ |
| Approval buttons | ✓ | ✓ | ✓ | ✗ | ✗ |
| Slash commands | ✓ | ✓ | ✓ | ✗ | ✗ |
| Voice in (transcribed) | ✓ | ✓ | ✓ | ✓ | ✗ |
| Voice out (TTS) | ✓ | ✓ | ✓ | ✓ | ✗ |
| Voice-out rendering | voice bubble | file + inline player | file + inline player | voice bubble (`ptt`) | — |
| Webhook mode | ✓ | ✗ | ✗ | ✗ | ✗ |
| Max message length | 4096 | 3000 | 2000 | 65536 | 100000 |

`✓ (probed)` — Slack's typing indicator uses an unofficial API; the adapter probes it once at runtime and reports the real result thereafter, so `canSendTyping` reflects what actually works on the workspace.

**Voice in** requires the adapter to classify an inbound upload as `type: 'audio'` — the gateway's transcription gate keys on nothing else. All four chat adapters do: Telegram from `voice` and `audio` messages, Slack and Discord from the upload's extension or content type, WhatsApp from `audioMessage`. A `.webm` upload on Slack or Discord stays a video and is not transcribed.

**Voice out** is a separate declaration — `voiceCaps` plus `sendVoiceNote`, see [Voice output caps](#voice-caps) below — which is why a channel can speak without being able to listen.

## Voice output caps {#voice-caps}

Voice output is declared per adapter as an `AdapterVoiceCaps` object, not inferred from method names. The gateway reads it through `isVoiceOutboundAdapter` and transcodes each reply into the first format the target accepts.

| Platform | Accepted outbound formats (preferred first) | Rendering (`kind`) | Platform flags | Size cap |
|---|---|---|---|---|
| Telegram | `opus`, `ogg`, `mp3` | `voice_note` | — | 50 MB |
| Slack | `mp3`, `m4a`, `wav` | `file` | — | 25 MB |
| Discord | `mp3`, `ogg`, `wav` | `file` | — | 25 MB |
| WhatsApp | `opus`, `ogg` | `voice_note` | `ptt: true` | 16 MB |
| Email | — | — | — | — |

- `voice_note` renders as a playable bubble; `file` renders as an upload the platform gives an inline player. Neither Slack nor Discord has a bot-accessible voice-bubble primitive, so both declare `file` rather than claiming one.
- Producing the accepted container needs `ffmpeg` on the gateway host unless the TTS provider already emits it. Without ffmpeg, a mismatched reply is skipped (`gateway.voice_format_unsupported`) rather than delivered unplayable.
- A reply over the size cap is skipped with `gateway.voice_too_large`; the text reply has already been delivered.

## How degradation works {#degradation}

The gateway never assumes a capability. Three behaviors depend directly on this matrix:

- **Streaming draft edits (W3.1).** When a chat is streaming-enabled and the adapter reports `canEditMessage`, the gateway delivers the reply as throttled `editMessage` updates that grow in place. When the adapter cannot edit (WhatsApp, Email), the reply is delivered as a single final message instead. Streaming defaults on for direct messages and off for group chats; set `display.streaming_edits` in `~/.ethos/config.yaml` to `off`, `dms`, or `all`.
- **Outbound media (W3.2).** When a tool produces media and the adapter reports `canSendFiles` (Telegram, Slack), the gateway maps it to native attachments (`sendPhoto` / `sendDocument` on Telegram, `files.uploadV2` on Slack). When the adapter cannot send files, the reply degrades to the text summary — no error, no dropped turn.
- **Spoken replies.** When a conversation's voice mode says speak and the adapter declares `voiceCaps`, the gateway synthesizes the reply once, transcodes it to the first accepted format, and calls `sendVoiceNote`. When the adapter declares no caps, nothing is synthesized and the turn ends with the text reply already delivered — the skip is recorded as a `gateway.voice_no_caps` event rather than passing silently. See [Send and receive voice notes on a channel](../using/how-to/voice-notes-on-channels.md).

## Source {#source}

Each adapter declares its capabilities in source. Consult the adapter for the exact runtime behavior:

| Platform | Adapter |
|---|---|
| Telegram | [extensions/platform-telegram/src/index.ts](../../../extensions/platform-telegram/src/index.ts) |
| Slack | [extensions/platform-slack/src/adapter.ts](../../../extensions/platform-slack/src/adapter.ts) |
| Discord | [extensions/platform-discord/src/index.ts](../../../extensions/platform-discord/src/index.ts) |
| WhatsApp | [extensions/platform-whatsapp/src/index.ts](../../../extensions/platform-whatsapp/src/index.ts) |
| Email | [extensions/platform-email/src/index.ts](../../../extensions/platform-email/src/index.ts) |

The capability contract itself — `ChannelCapabilities` and the legacy `AdapterCapabilities` — lives in [packages/types/src/platform.ts](../../../packages/types/src/platform.ts).

## See also {#see-also}

- [Telegram platform](telegram.md)
- [Slack platform](slack.md)
- [Discord platform](discord.md)
- [Send and receive voice notes on a channel](../using/how-to/voice-notes-on-channels.md)
- [Add a channel adapter](../building/tutorials/add-a-channel-adapter.md)
