---
title: "Local voice: Kokoro TTS + Whisper large v3 STT"
description: "Point Ethos speech-to-text and text-to-speech at a self-hosted OpenAI-compatible endpoint — Whisper large v3 and Kokoro, no cloud and no API key."
kind: how-to
audience: user
slug: local-voice
time: "15 min"
updated: 2026-08-12
---

## Task

Run speech-to-text and text-to-speech against a self-hosted server on your own machine — no cloud provider, no API key.

## Result

Ethos transcribes voice input with Whisper large v3 and speaks replies with Kokoro, using two local OpenAI-compatible endpoints wired through `auxiliary.asr` and `auxiliary.tts`.

## Prereqs

- `ethos` on `PATH` (Node 24+). Run `ethos --version` to confirm.
- A machine that can run the voice servers (a GPU helps Whisper large v3; Kokoro runs on CPU).
- The endpoints are OpenAI-compatible, so any server that speaks `POST /v1/audio/transcriptions` (STT) and `POST /v1/audio/speech` (TTS) works — not just the two below.

## Run the servers

Two local servers, each exposing the OpenAI audio routes.

- **TTS — [kokoro-fastapi](https://github.com/remsky/Kokoro-FastAPI)** exposes `POST /v1/audio/speech`. Default port **8880**.
- **STT — an OpenAI-compatible Whisper server** such as [Speaches](https://github.com/speaches-ai/speaches) (formerly faster-whisper-server) exposes `POST /v1/audio/transcriptions`. Default port **8000**.

Follow each project's own install guide to start the server; the ports above are the defaults Ethos assumes and both are overridable. Confirm both are up before wiring Ethos:

```bash
curl -s http://localhost:8880/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"model":"kokoro","voice":"af_bella","input":"hello"}' --output /tmp/hello.wav
curl -sI http://localhost:8000/v1/models
```

```
HTTP/1.1 200 OK
```

## Configure — two ways

Pick one. The web form writes the same `auxiliary.*` keys the YAML block below sets.

### Web Settings → Voice

1. Open the web dashboard and go to **Settings → Voice**.
2. Set **STT Provider** to `local-stt`. **STT Base URL** and **STT Model** prefill to `http://localhost:8000/v1` and `whisper-large-v3` — change them if your server differs. Leave **STT API key** blank.
3. Set **TTS Provider** to `local-tts`. **TTS Base URL** and **TTS Model** prefill to `http://localhost:8880/v1` and `kokoro`. Leave **TTS API key** blank.
4. Type a **Voice ID** into the free-form field — for Kokoro, e.g. `af_bella`.
5. Save.

### `config.yaml`

`~/.ethos/config.yaml` uses flat dotted keys. Add the two blocks — no `apiKey` line, because a local server needs none:

```yaml
auxiliary.asr.provider: local-stt
auxiliary.asr.baseUrl: http://localhost:8000/v1
auxiliary.asr.model: whisper-large-v3

auxiliary.tts.provider: local-tts
auxiliary.tts.baseUrl: http://localhost:8880/v1
auxiliary.tts.model: kokoro
auxiliary.tts.voice: af_bella
```

Every field except `provider` is optional and falls back to the default shown. Restart `ethos` (or the gateway) after editing the file.

## Use a local binary instead of a server

If you already have `whisper-cli`, Piper, or macOS `say` on the machine, skip the servers: the `command-stt` and `command-tts` providers run a shell template you supply. Ethos writes the input file, runs the command, and reads the output file back.

```yaml
auxiliary.asr.provider: command-stt
auxiliary.asr.command: whisper-cli -f {input_path} -otxt -of {output_path}

auxiliary.tts.provider: command-tts
auxiliary.tts.command: say -o {output_path} -f {input_path}
auxiliary.tts.outputFormat: wav
```

Placeholders substituted before the command runs: `{input_path}`, `{output_path}`, `{language}` (STT), and `{format}`, `{voice}`, `{speed}` (TTS). Omit `command` and the provider refuses to load rather than failing on the first utterance.

## Keep voice on this machine

Local providers advertise `caps.local`, so Ethos can enforce "no audio leaves this machine" as a rule rather than a habit. Declare the allowlist:

```yaml
voice.trustedPlugins:
```

An empty value trusts local providers only. Every non-local provider — cloud STT/TTS, and hosted realtime providers when they land — must be named to be usable:

```yaml
voice.trustedPlugins: openai-tts
```

Declaring the key is what arms the gate; omitting it leaves the gate off, which is the default. With the gate armed, an untrusted provider fails on use with `... is not local and is not in voice.trustedPlugins — refusing to send audio off this machine` — on every surface, including a provider picked live in web **Settings → Voice**, and before any audio reaches it.

Check what actually resolved:

```bash
ethos doctor
```

```
Voice
  ✓  STT local-stt (local)
  ✓  TTS local-tts (local)
  ✓  Egress gate armed (voice.trustedPlugins: local providers only)
```

## Voice ids are server-specific

The **Voice ID** field is free-form on purpose — every server and model names its voices differently. Kokoro ships `af_bella`, `am_adam`, and others; a different TTS server will use its own ids. Read your server's voice list (kokoro-fastapi serves it at `GET /v1/audio/voices`) and paste the id you want. Ethos does not validate it against a fixed list.

## The model field is free-form too

STT model names vary by server: some accept `whisper-large-v3`, others want the fully qualified `Systran/faster-whisper-large-v3`. Use whatever id your server expects — Ethos passes it through unchanged. The same applies to the TTS `model` field.

## Verify

- **TTS** — in the web chat, click the **Play** button on an assistant message. It should speak the reply in the configured voice. If the button reports "TTS not configured," the `auxiliary.tts` block did not load — recheck the provider value and restart.
- **STT** — hold the microphone button in the composer, speak, and release. The transcript should appear in the input box.
- Both routes hit your local servers only; no request leaves the machine.

## Troubleshoot

- **`Voice not configured — add auxiliary.asr to ~/.ethos/config.yaml`** — the STT block is missing or the provider value is wrong. Confirm `auxiliary.asr.provider: local-stt` and restart.
- **Connection refused / no audio** — the server is down or on a different port. Re-run the `curl` checks above; fix the port in the matching `baseUrl`.
- **`model not found` from the server** — the server wants a different model id. Try the fully qualified name (e.g. `Systran/faster-whisper-large-v3`) in the `model` field.
- **Unknown or silent voice** — the Voice ID is not one your TTS server ships. Fetch the server's voice list and use an id from it.
- **`refusing to send audio off this machine`** — `voice.trustedPlugins` is armed and the selected provider is not local. Add the provider id to the list, or switch to `local-stt` / `local-tts` / a `command-*` recipe.
- **`command-stt requires a \`command\` template`** — the provider was selected without `auxiliary.asr.command`. Add the template, or pick a server-backed provider.

## See also

- [Qualify a local model](qualify-a-local-model) — score a local text model before trusting it with work.
- [Configure providers](configure-providers) — wire the main LLM provider, including local OpenAI-compatible endpoints.
