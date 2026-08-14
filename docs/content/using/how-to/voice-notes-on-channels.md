---
title: "Send and receive voice notes on a channel"
description: "Talk to your agent on Telegram, Slack, Discord, or WhatsApp and get a spoken reply back, with per-conversation control over when it speaks."
kind: how-to
audience: user
slug: voice-notes-on-channels
time: "10 min"
updated: 2026-08-14
---

## Task

Hold the microphone button in Telegram, Slack, Discord, or WhatsApp, say what you want, and get a voice note back — with per-conversation control over when the agent speaks and when it stays text.

## Result

- A voice memo you send on Telegram or Slack is transcribed and answered as a normal turn.
- The reply comes back as a playable voice note on any of the four channels whose [channel adapter](../../getting-started/glossary.md#channel-adapter) (the module that bridges one messaging platform to the agent) declares voice output.
- `/voice off|mirror_inbound|all` sets the [voice mode](../../getting-started/glossary.md#voice-mode) (whether this conversation gets spoken replies) for that one conversation, and the setting outlives `/new` and a gateway restart.

## Prereqs

- A working [gateway](../../getting-started/glossary.md#gateway) (the process that runs every channel adapter) with at least one channel connected — see [Telegram](../../platforms/telegram.md), [Slack](../../platforms/slack.md), or [Discord](../../platforms/discord.md).
- A configured TTS provider. Any of the routes in [Local voice](local-voice.md) works, cloud or local.
- A configured STT provider, if you want to *send* voice as well as receive it.
- `ffmpeg` on the gateway host. It is optional but close to required in practice: see [step 1](#1-install-ffmpeg).

## 1. Install ffmpeg {#1-install-ffmpeg}

Every platform wants speech in a container of its own choosing, and no TTS provider emits all of them. ffmpeg is what converts one to the other.

```bash
# macOS
brew install ffmpeg
# Debian / Ubuntu
sudo apt-get install -y ffmpeg
# Amazon Linux 2023 / Fedora
sudo dnf install -y ffmpeg
```

Confirm the gateway can see it:

```bash
ffmpeg -version
```

```
ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers
```

If ffmpeg lives somewhere the gateway's `PATH` does not reach, point at it directly:

```yaml
voice.transcode.ffmpegPath: /opt/homebrew/bin/ffmpeg
```

Without ffmpeg the gateway still runs and still speaks — but only where the TTS provider's own output format is already one the target platform accepts. Everything else is skipped rather than delivered as an unplayable file, and the gateway says so once at startup:

```
⚠ ffmpeg not found — voice notes will be delivered only in the formats the TTS provider already produces. Install ffmpeg to enable the rest.
```

## 2. Start the gateway and send a voice memo

```bash
ethos gateway start
```

Send a voice memo to the bot from any of the four channels. The audio is normalized to the container your STT provider prefers, transcribed, and appended to the turn text; the agent answers as it would answer typed text. A transcription that fails or comes back as a known hallucination degrades to `(voice message)` rather than losing the turn.

Because the default mode is `mirror_inbound`, the reply comes back as a voice note as well as text — it speaks back when you spoke to it.

**Which channels can listen.** All four — Telegram, Slack, Discord, and WhatsApp — classify an inbound voice memo as audio and transcribe it, and all four can speak back. Email does neither. The full grid is in the [channel capability matrix](../../platforms/capability-matrix.md#matrix).

## 3. Set the mode for one conversation

`/voice` is a per-conversation switch, not a global one — a work channel can stay silent while a personal chat talks.

```
/voice all
```

```
✓ Voice mode: all
```

| Mode | When the agent speaks |
|---|---|
| `off` | Never. Nothing overrides this, including a wake-word turn. |
| `mirror_inbound` | When your message carried audio (the default). |
| `all` | Every reply. |

Send `/voice` with no argument to read the current setting:

```
/voice
```

```
Voice mode: all
Usage: /voice off|mirror_inbound|all
```

The mode is written to `~/.ethos/voice/lane-modes.json`, keyed by conversation. It survives a gateway restart, and it deliberately survives `/new` — "talk to me out loud in this chat" is a durable preference, not [session](../../getting-started/glossary.md#session) state (the conversation history `/new` resets).

To change where *new* conversations start, set the deployment default:

```yaml
voice.defaultMode: all
```

## 4. Silence one channel entirely

`/voice` is a conversational choice; silencing a whole platform is an operator one, and the operator wins. An explicit `false` keeps a channel text-only no matter what any conversation on it asked for.

```yaml
voice.channels.slack.ttsOut: false
```

Accepted platform ids: `telegram`, `slack`, `discord`, `whatsapp`. An unknown id is ignored on read. The same switches are in **Settings → Voice**, one per channel.

## 5. Give a personality a voice per language

An inbound voice note's language is derived from its transcript and used to pick the voice — but only among the languages the personality itself declares. In the personality's `config.yaml`:

```yaml
voice.tts_voice: af_bella
voice.languages.es: ef_dora
```

A Spanish voice note now comes back in `ef_dora`; everything else uses `af_bella`. A personality that declares no `voice.languages` map offers no candidates, so no guess is made and `tts_voice` always wins. Full precedence rules are in the [personality config reference](../reference/personality-yaml.md#voice).

## Verify

Send a voice memo on Telegram with `ethos gateway start` running. You should get two messages back: the text reply, then a playable voice bubble.

Check what the gateway actually decided:

```bash
ethos doctor
```

```
Voice
  ✓  STT local-stt (local)
  ✓  TTS local-tts (local)
```

Confirm the mode persisted by restarting the gateway and asking again:

```
/voice
```

```
Voice mode: all
Usage: /voice off|mirror_inbound|all
```

## Troubleshoot

- **Text reply arrives, voice note does not.** The most common cause is a format the target cannot play and no ffmpeg to convert it — the reply is skipped rather than delivered broken. Install ffmpeg (step 1) and check the startup line.
- **`⚠ ffmpeg not found` at startup** — ffmpeg is not on the gateway's `PATH`. Install it, or set `voice.transcode.ffmpegPath` to the absolute path.
- **Nothing speaks on one channel only.** Check `voice.channels.<platform>.ttsOut` — an explicit `false` outranks `/voice all`.
- **Nothing speaks anywhere.** Check that a TTS provider resolves at all with `ethos doctor`, and that [`voice.trustedPlugins`](../reference/config-yaml.md#voice-trusted-plugins) is not refusing the one you configured.
- **Telegram audio arrives as a downloadable document, not a player.** That was a defect in the `sendAudio` path and is fixed. If you still see it, you are on an older gateway build — restart it.
- **A voice memo comes back answered as if it were empty.** No speech-to-text provider resolved, so the turn degraded to `(voice message)`. Run `ethos doctor` and check its Voice section.
- **A voice note arrives twice, or arrives long after the fact.** Delivery is at-least-once by design. An unconfirmed voice note stays as a pending obligation and is re-sent on the next gateway start — see [Why does a redelivered voice note re-send the recording?](../../building/explanation/why-voice-replies-redeliver.md).
- **`~/.ethos/voice/artifacts/` is growing.** Recordings are deleted on confirmed delivery, so growth means deliveries are not being confirmed. Bound it with [`voice.artifacts.abandonAfterDays`](../reference/config-yaml.md#voice-artifacts) and `voice.artifacts.maxTotalMb`, then find out why the sends are failing.

## See also

- [`config.yaml` reference: `voice.defaultMode`](../reference/config-yaml.md#voice-default-mode) — every `voice.*` key with its bounds and default
- [Channel capability matrix](../../platforms/capability-matrix.md#voice-caps) — which formats each platform accepts and how each renders a voice note
- [Local voice: Kokoro TTS + Whisper large v3 STT](local-voice.md) — wire STT and TTS to servers on your own machine
- [Why does a redelivered voice note re-send the recording?](../../building/explanation/why-voice-replies-redeliver.md) — what happens to a voice note whose delivery is never confirmed
- [Run a wake satellite](./run-a-wake-satellite.md) — the other voice surface: a microphone in a room, routed to one personality
