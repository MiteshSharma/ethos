---
title: TTS — text_to_speech
description: "text_to_speech tool reference: provider abstraction, voice selection, format negotiation, channel-adapter outbound."
kind: reference
audience: developer
slug: tts-tools
updated: 2026-05-17
---

# TTS — `text_to_speech`

`text_to_speech` is the outbound voice tool. The agent passes text; a `TtsProvider` synthesises audio; channel adapters that support voice playback (Telegram `sendVoice`, Discord attachment, Slack `files.upload`) deliver it as a voice message. Symmetric with the inbound STT path already running on the Telegram adapter.

## Source {#source}

Tool factory: [`extensions/tools-tts/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-tts/src/index.ts) (`createTtsTools`). Provider implementations under [`extensions/tools-tts/src/providers/`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-tts/src/providers). Wiring: [`packages/wiring/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/index.ts) registers the tool with the provider built from `config.auxiliary?.tts`.

## Schema {#schema}

| Field | Type | Required | Description |
|---|---|---|---|
| `text` | string | yes | Text to synthesise. Hard cap **4096 characters** — call repeatedly for longer content. |
| `voice` | string | no | Voice id (provider-specific — e.g. OpenAI's `alloy` / `nova` / `shimmer`). Omit for provider default. |
| `speed` | number | no | Speed multiplier (`0.25` to `4.0`, default `1.0`). Provider clamps out-of-range values. |

Tool metadata: `toolset: 'voice'`, `maxResultChars: 1024`, `capabilities: {}`. The capability surface is intentionally empty — voice delivery is the channel adapter's responsibility.

## Availability gate {#availability}

`text_to_speech` ships as **unavailable** when no provider is configured. The wiring path:

```ts
for (const tool of createTtsTools({ provider: null })) tools.register(tool);
```

`provider: null` means `isAvailable()` returns `false`, the tool registry filters it out of the personality's exposed set, and the LLM never sees it as an option. To enable, configure `auxiliary.tts.*` in `~/.ethos/config.yaml`:

```yaml
auxiliary.tts.provider: openai
auxiliary.tts.apiKey: ${secrets:providers/openai/apiKey}
auxiliary.tts.model: tts-1            # tts-1 (cheap, fast) / tts-1-hd (higher quality)
auxiliary.tts.defaultVoice: alloy
```

Wiring then constructs a `TtsProvider` and re-registers the tool with `isAvailable() === true`.

## Provider contract {#provider-contract}

```ts
export interface TtsProvider {
  synthesize(text: string, opts?: { voice?: string; speed?: number }):
    Promise<{ audio: Buffer; format: 'mp3' | 'opus' | 'wav' }>;
  readonly name: string;
  readonly availableVoices: string[];
}
```

Providers return raw audio bytes plus the container format. The tool wraps the bytes in a `MEDIA:` envelope the channel adapter recognises.

## Channel-adapter outbound {#adapter-outbound}

Adapter behaviour at delivery time:

| Adapter | Behaviour |
|---|---|
| **Telegram** | Routes through `sendVoice` (`.opus`) or `sendAudio` (`.mp3` / `.wav`). Plays inline as a voice bubble. |
| **Discord** | Posts as a message attachment. Discord clients auto-show inline audio for `audio/*` MIME types. |
| **Slack** | Uses `files.upload` with `chat:write` + `files:write` scopes. Adapter must have `canSendFiles: true` (configured at adapter init). |
| **Email** | Attached to the outgoing message as `audio/mpeg` / `audio/ogg`. |

If the active channel can't deliver audio (no `canSendFiles`, missing scopes), the tool returns an error rather than silently dropping. Use `send_message` to a target on a different adapter as a fallback.

## Errors {#errors}

| `code` | When | Operator fix |
|---|---|---|
| `input_invalid` | `text` empty or > 4096 chars | Split, summarise, or chunk |
| `not_available` | No provider configured | Set `auxiliary.tts.*` in `config.yaml` |
| `not_available` | Provider unreachable (network) | Check API key + connectivity |
| `execution_failed` | Provider rejected the request (e.g. voice id unknown) | Pick a voice from `availableVoices` |
| `execution_failed` | Channel adapter can't carry audio | Use a different adapter via `send_message` |

## Examples {#examples}

### Read a calendar entry out loud {#example-calendar}

A voice-bot personality with `text_to_speech` in its toolset:

```text
text_to_speech({
  text: "Next meeting: standup at 10:30 with the engineering team.",
  voice: "alloy"
})
```

Returns a `MEDIA:` path that the Telegram adapter delivers as a voice bubble in the chat.

### Broadcast to multiple channels {#example-broadcast}

Compose with `send_message`:

```text
1. text_to_speech({ text: "Deploy starting" })  → MEDIA: path
2. send_message({ platform: "telegram", target: "-1001234567890", body: "<MEDIA:...>" })
3. send_message({ platform: "slack",    target: "C0DEPLOY",        body: "<MEDIA:...>" })
```

Each adapter delivers it according to its own outbound-files capability.

### Slow it down for accessibility {#example-slow}

```text
text_to_speech({
  text: "Please review the document and confirm your selection.",
  voice: "nova",
  speed: 0.85
})
```

## See also {#see-also}

- [`send_message` reference](messaging-tools.md) — pair TTS output with cross-channel delivery.
- [`vision_analyze` reference](vision-tools.md) — the inbound multimodal counterpart.
- [Audience boundary](../explanation/audience-boundary.md) — `audience: 'user'` vs `'internal'` for tool progress events.
