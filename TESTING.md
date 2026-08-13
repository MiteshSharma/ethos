# Testing Ethos voice end to end

How to make Ethos listen and speak on this machine, what proves itself without any
setup, and what still needs credentials or hardware you supply.

Everything below was verified against the code on the `voice-first-class` branch.
Where something could not be verified from inside the repo, it says so.

---

## TL;DR — what you can exercise today

**Works with zero credentials and zero servers**

- The whole automated suite: `pnpm typecheck && pnpm lint && pnpm test`.
- Voice text processing (sanitize, sentence split, hallucination filter, voice-mode
  decision) — pure functions, fully unit-tested.
- Provider resolution and the local-only egress gate — `packages/core/src/providers/voice-resolution.ts`.
- `buildVoiceStack()` construction, including the trust gate and personality-voice
  precedence, against fake providers.
- `ethos doctor` — its Voice section resolves providers for real (constructs them;
  makes no network calls) and prints what the gate would do.
- macOS only: a real spoken reply through `command-tts` + the built-in `say` binary.
  No account, no server, no download. See [Cheapest smoke test](#cheapest-smoke-test-macos-say).

**Needs something you supply**

| To hear/see | You supply |
|---|---|
| Local server STT | A Whisper server speaking `POST /v1/audio/transcriptions` (default `http://localhost:8000/v1`) |
| Local server TTS | A Kokoro-style server speaking `POST /v1/audio/speech` (default `http://localhost:8880/v1`) |
| Local binary STT | `whisper-cli` (or any CLI transcriber) on `PATH` |
| Browser talk-mode | A built SPA (`make web`) and a personality whose toolset lists `voice_session` |
| Browser realtime tier | An OpenAI key with Realtime access and a `voice.realtime.providers.<name>` entry. `gemini-live` is contract-only and cannot serve a browser call — see [4b. The realtime tier](#4b-the-realtime-tier) |
| Voice notes over Telegram | A Telegram bot token in `~/.ethos/config.yaml` |
| Telephony, LiveKit transport | Native bindings, a LiveKit server, a SIP trunk, a rented number — none are repo dependencies |

**How do I just hear it talk?** Configure `auxiliary.tts` (30 seconds — see
[Cheapest smoke test](#cheapest-smoke-test-macos-say)), run `make web`, open
`http://localhost:3000`, send a message, click the Play button on the reply.

---

## 1. Zero-setup verification

Run from the worktree root (`/Users/mitesh/personal/sandbox/ethos-worktrees/voice-first-class`).

```bash
pnpm typecheck
pnpm lint
pnpm test
```

`pnpm check` runs all three in that order.

At the time of writing this branch ran **815 test files / 8768 tests** (the two
`doctor-provider-probe` cases that reach the network fail in an offline sandbox —
they fail identically on `main`). Those numbers are a snapshot, not a contract —
they drift every time a test lands. Treat a *failure*, not a count mismatch, as
the signal. (`find` reports more `*.test.ts` files on disk than vitest runs; a few
sit outside the `include` globs in `vitest.config.ts`.)

### The suites worth knowing by name

Voice text + resolution + wiring + the frozen-schema gate:

```bash
pnpm vitest run \
  packages/voice-text \
  packages/core/src/__tests__/voice-resolution.test.ts \
  packages/wiring/src/__tests__/voice-stack.test.ts \
  packages/types/src/__tests__/personality-field-count.test.ts
```

Verified: 8 files, 129 tests, ~1.2s.

Surfaces — browser talk-mode, web-api, gateway, providers, session:

```bash
pnpm vitest run \
  apps/web/src/features/voice \
  apps/web-api/src/voice \
  packages/web-contracts/src/__tests__/voice-socket.test.ts \
  apps/web-api/src/services/__tests__/voice.service.test.ts \
  extensions/gateway/src/__tests__/voice-trust-gate.test.ts \
  extensions/gateway/src/__tests__/voice-pipeline.test.ts \
  packages/config/src/__tests__/config-voice-trusted-plugins.test.ts \
  packages/config/src/__tests__/config-voice-provider-knobs.test.ts \
  extensions/voice-providers/src \
  extensions/voice-session/src
```

Verified: 23 files, 196 tests, ~1.6s.

The realtime tier — contract, providers, mint, control lane, browser:

```bash
pnpm vitest run \
  packages/types/src/__tests__/voice-realtime.test.ts \
  packages/voice-realtime-protocol/src \
  extensions/voice-providers/src/__tests__/realtime-contract.test.ts \
  extensions/voice-providers/src/__tests__/realtime-openai.test.ts \
  extensions/voice-providers/src/__tests__/realtime-gemini.test.ts \
  extensions/voice-providers/src/__tests__/realtime-registry.test.ts \
  extensions/voice-providers/src/__tests__/realtime-fake.test.ts \
  packages/core/src/__tests__/voice-realtime-roster-resolution.test.ts \
  apps/web-api/src/services/__tests__/voice-realtime-token.test.ts \
  apps/web-api/src/services/__tests__/voice-realtime-session-config.test.ts \
  apps/web-api/src/services/__tests__/voice-realtime-session-cost.test.ts \
  extensions/tools-voice/src/__tests__/realtime-host.test.ts \
  apps/web-api/src/voice/__tests__/realtime-control-lane.test.ts \
  apps/web-api/src/voice/__tests__/realtime-control-deps.test.ts \
  apps/web/src/features/voice/__tests__/realtime-voice-call-client.test.ts \
  apps/web/src/features/voice/__tests__/realtime-control-channel.test.ts \
  apps/web/src/features/voice/__tests__/talk-mode-client.test.ts \
  apps/web/src/features/voice/__tests__/voice-call-reducer.test.ts \
  apps/web/src/features/voice/__tests__/call-strip.test.ts \
  apps/web/src/features/voice/__tests__/call-strip-css.test.ts \
  apps/web/src/features/voice/__tests__/call-strip-layout.test.ts \
  apps/web/src/features/voice/__tests__/mic-meter.test.ts
```

Verified: 22 files, 292 tests, ~11s. What each defends is in
[4b. The realtime tier](#4b-the-realtime-tier); every one of them runs against
fakes, with no credential and no socket.

What each one is defending:

| Suite | Pins |
|---|---|
| `apps/web/src/features/voice/__tests__/talk-mode-regression-pin.test.ts` | The browser talk loop before the streaming rewrite: utterance → transcribe → turn → **ordered** playout, sentence pipelining, barge-in, the thinking earcon gate, and dropped phantom utterances |
| `apps/web-api/src/voice/__tests__/voice-lane.test.ts` | The server end of the binary lane: a superseded utterance's transcript/audio is dropped rather than sent, bounded capture and utterance maps, and **cross-lane isolation** — two lanes sharing an utterance id and one provider service never see each other's audio |
| `apps/web-api/src/voice/__tests__/voice-socket.test.ts` | The upgrade policy (path, Origin, auth cookie) and one real `ws` round trip, including the lane dying with a dropped socket |
| `apps/web/src/features/voice/__tests__/webaudio-playout.test.ts` | Absolute-time pacing: consecutive buffers are contiguous on the audio clock however late or jittery their arrival, and a dry queue never schedules into the past |
| `apps/web/src/features/voice/__tests__/streaming-voice-call-client.test.ts` | The streaming conversation: PCM up, audio down, stale results dropped, barge-in keeps only what was heard, and a WS drop discards the in-flight utterance |
| `packages/voice-text/src/__tests__/drift-gate.test.ts` | That no second copy of `sanitizeForSpeech` / `splitSentences` / `isHallucination` reappears in gateway, voice-session, web-api or web |
| `packages/core/src/__tests__/voice-resolution.test.ts` | The four resolution outcomes (`not_configured`, `unknown_provider`, `untrusted_provider`, `init_failed`) and the `resolveVoicePreferences` precedence table |
| `packages/wiring/src/__tests__/voice-stack.test.ts` | `buildVoiceStack`: absent config → `null`, the `trustedVoicePlugins` egress gate, transport construction, personality voice beating global config |
| `extensions/gateway/src/__tests__/voice-trust-gate.test.ts` | The same gate on the gateway lane, including "gate off when no allowlist is passed" |
| `packages/config/src/__tests__/config-voice-trusted-plugins.test.ts` | That declaring `voice.trustedPlugins` *at all* arms the gate, and that an empty list is a distinct, meaningful value |
| `extensions/voice-providers/src/__tests__/streaming-tts.test.ts` | That `local-tts` / `openai-tts` really stream: chunks yielded as the body arrives, in order, one request per sentence — and that a batch-only provider is still gated off |
| `extensions/voice-session/src/__tests__/playout-queue.test.ts` | Sentence prefetch: N+1 synthesizes while N plays, playout never reorders, nothing runs more than one sentence ahead, and cancel aborts the prefetched item |
| `packages/config/src/__tests__/config-voice-provider-knobs.test.ts` | That `auxiliary.tts.outputFormat` / `timeout` / `maxTextLength` and `auxiliary.asr.timeout` are lifted onto `EthosConfig` and survive a write/read round-trip |
| `extensions/voice-providers/src/__tests__/conformance.test.ts` | `validateSttProvider` / `validateTtsProvider`, incl. the refusal of a v1 STT provider that still declares the deleted `transcribe(audioPath)` |
| `packages/types/src/__tests__/personality-field-count.test.ts` | That `PersonalityConfig` has exactly the 28 fields in `.personality-field-count` — adding `voice` bumped it from 27 |
| `extensions/personalities/src/__tests__/voice-personality.test.ts` | The built-in `voice` personality: its declared voice block, its restricted toolset, and the ~2k-token static-prompt budget (latency decision L5) |
| `packages/core/src/__tests__/voice-origin-annotation.test.ts` | That a spoken turn is marked on the MESSAGE (never in the system prompt), rides alongside the audio marker rather than replacing it, reaches the `before_tool_call` payload, and leaves a mixed typed+spoken session's static prefix byte-identical |
| `packages/core/src/__tests__/spoken-style-injector.test.ts` | That the spoken-style block is personality-gated, static, and does not move the prompt prefix between turns |
| `packages/wiring/src/__tests__/spoken-confirmation.test.ts` | The spoken-confirmation gate — including that a far-end caller's voice can never satisfy an owner confirmation, even with a recorded confirmation on the same call id |
| `extensions/gateway/src/__tests__/voice-personality-voice.test.ts` · `apps/web-api/src/services/__tests__/voice-personality-voice.test.ts` | That the personality's voice reaches the TTS provider on the channel and browser paths, asserted on the provider's argument |

---

## 2. Local-only voice loop (no cloud keys, no accounts)

Two config blocks in `~/.ethos/config.yaml` decide everything. The file uses flat
dotted keys, not nested YAML.

### Option A — local servers over OpenAI-compatible HTTP

```yaml
auxiliary.asr.provider: local-stt
auxiliary.asr.baseUrl: http://localhost:8000/v1
auxiliary.asr.model: whisper-large-v3

auxiliary.tts.provider: local-tts
auxiliary.tts.baseUrl: http://localhost:8880/v1
auxiliary.tts.model: kokoro
auxiliary.tts.voice: af_bella
```

Every line except `provider` is optional; the values above are the code defaults
(`extensions/voice-providers/src/local-stt.ts`, `local-tts.ts`). **`apiKey` is
optional** for both — local servers usually want none.

Getting the servers running is the part this repo cannot do for you. The canonical
recipe — which server to install, which ports, how to confirm they are up — lives in
[`docs/content/using/how-to/local-voice.md`](docs/content/using/how-to/local-voice.md).
The short version: kokoro-fastapi for TTS on **8880**, an OpenAI-compatible Whisper
server (Speaches / faster-whisper-server) for STT on **8000**. Follow each project's
own install guide; **the exact upstream install commands could not be verified from
inside this repo, so they are deliberately not reproduced here.** Confirm both are up:

```bash
curl -sI http://localhost:8000/v1/models
curl -s http://localhost:8880/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"model":"kokoro","voice":"af_bella","input":"hello"}' --output /tmp/hello.wav
```

Restart `ethos` (or the gateway, or `ethos serve`) after editing the config file.

### Option B — no server at all: `command-stt` / `command-tts`

Both are registered in `packages/wiring/src/voice-registries.ts`, both advertise
`caps.local`, and both take an operator-supplied shell template. Ethos writes the
input file into `os.tmpdir()`, runs `sh -c <template>`, reads the output file back,
and unlinks both in a `finally`.

Placeholders, read straight from the source:

| Provider | Placeholders |
|---|---|
| `command-stt` (`extensions/voice-providers/src/command-stt.ts`) | `{input_path}`, `{output_path}`, `{language}` |
| `command-tts` (`extensions/voice-providers/src/command-tts.ts`) | `{input_path}`, `{output_path}`, `{format}`, `{voice}`, `{speed}` |

`command` is required. Omit it and the provider refuses to construct rather than
failing on the first utterance.

#### Cheapest smoke test (macOS `say`)

macOS ships a TTS binary. This is the fastest possible way to hear Ethos speak.

```yaml
auxiliary.tts.provider: command-tts
auxiliary.tts.outputFormat: wav
auxiliary.tts.command: say --file-format=WAVE --data-format=LEI16@22050 -o {output_path} -f {input_path}
```

Why it is shaped like that, all verified by running it on this machine:

- `say -o out.mp3 -f in.txt` exits 0 and writes a **16-byte silent file**. It does
  not error; you simply get no audio. `say -o out.wav` with no format flags fails
  outright: `Opening output file failed: fmt?`.
- `say --file-format=WAVE --data-format=LEI16@22050` writes a genuine 22.05 kHz mono
  WAV — **127,988 bytes** for a one-sentence reply, against 16 for the silent stub.
- `auxiliary.tts.outputFormat: wav` makes `{output_path}` end in `.wav` and makes the
  provider report `format: 'wav'`, so the `audio/wav` MIME the web-api hands the
  browser matches the bytes. Before this key was lifted onto `EthosConfig` it was
  parsed and dropped, the extension was always `.mp3`, and the honest recipe needed
  an `ffmpeg` transcode stage. It does not any more.

#### Local binary STT

```yaml
auxiliary.asr.provider: command-stt
auxiliary.asr.command: whisper-cli -f {input_path} -otxt -of {input_path} && mv {input_path}.txt {output_path}
```

**Caveat, stated plainly:** `whisper-cli` is not installed on this machine, so this
template was **not** executed. It is written this way because `whisper.cpp`'s `-of`
is documented as "output file path (without file extension)" and appends `.txt`
itself — while Ethos hands `{output_path}` as a path that already ends in `.txt`
and then reads exactly that path back (`extensions/voice-providers/src/command-stt.ts`).
So `-of {output_path}` writes `<name>.txt.txt` and Ethos reads a file that was never
created. `docs/content/using/how-to/local-voice.md` and the `commandSttFactory`
docstring both carried that broken form; both now carry the `-of {input_path}` +
`mv` form above. Verify against your own `whisper-cli --help` before trusting either.

### Check what actually resolved

```bash
ethos doctor
```

The Voice section (`voiceReport()` in `apps/ethos/src/commands/doctor.ts`) runs the
*same* resolution path the pipeline uses — same registries, same gate — so a refusal
shows up here rather than as silent "voice doesn't work". It constructs providers; it
makes no network calls, so a green line means "resolvable", not "reachable".

```
Voice
  ✓  STT local-stt (local)
  ✓  TTS local-tts (local)
  ✓  Egress gate armed (voice.trustedPlugins: local providers only)
  –  0 voice bot(s); LiveKit absent; SIP trunk absent.
```

Reading it:

- `✓ <id> (local)` / `(remote)` — resolved; `local` means it advertises `caps.local`
  and passes the egress gate unconditionally.
- `– STT not configured.` — no `auxiliary.asr.provider`.
- `✗ STT: …` — resolved and failed. The message is the resolution error verbatim:
  unknown provider, factory threw, or refused by the gate.
- The last line only appears when a `voice.*` block exists.

### The flows to try

#### Browser — Play button, mic button, talk-mode

```bash
make web          # builds the SPA, then `ethos serve` on :3000
# or: make web-dev  (Vite :5173 with HMR, ethos serve :3000)
```

Open `http://localhost:3000`.

1. **Play button** — send a message, then click Play on the assistant bubble. This is
   the shortest TTS path: `rpc.voice.synthesize({ text })` → the resolved TTS
   provider → base64 audio back to the browser. The button only renders when the
   server reports the `voice_tts` capability, which is true when
   `auxiliary.tts.provider` is set.
2. **Mic button** — hold, speak, release. Goes through `rpc.voice.transcribe`; the
   transcript lands in the composer.
3. **Talk-mode** — the phone icon in the personality bar.

   **Gating requirement:** the active personality's `toolset.yaml` must list
   `voice_session`. Otherwise the button renders **disabled** with the tooltip
   *"Voice not enabled for `<name>` — add the voice_session capability to its
   toolset"* (`apps/web/src/features/voice/TalkMode.tsx`, predicate in `gating.ts`).

   The built-in **`voice`** personality ships with it — pick `Voice` in the
   personality bar and the phone button is live. To enable it on a personality
   of your own:

   ```bash
   mkdir -p ~/.ethos/personalities/talker
   # SOUL.md + config.yaml as usual, then:
   printf -- '- voice_session\n- read_file\n' > ~/.ethos/personalities/talker/toolset.yaml
   ```

   Personalities hot-reload; no restart needed.

   What talk-mode is today: a **persistent binary WebSocket**
   (`streaming-voice-call-client.ts` → `GET /voice/ws`) — mic PCM streams up as it
   is captured, the endpoint fires the transcript back down, the normal chat turn
   runs, each reply sentence is synthesized on the same socket, and the audio is
   scheduled on the WebAudio clock. Barge-in cancels the utterance server-side, so
   nothing already in flight for it is ever played.

   A browser missing any streaming piece falls back to the **batch HTTP loop**
   (`batch-voice-call-client.ts`) — `transcribe` RPC per utterance, `synthesize`
   RPC per sentence, `<audio>` playout. Same conversation, same events.

   VAD and barge-in are tunable live under **Settings → Voice → Advanced**. Defaults
   (`DEFAULT_VOICE_TUNING`): `endpointSilenceMs 700`, `bargeThreshold 0.06`,
   `bargeSustainMs 250`, `speechThreshold 0.02`, `speechMinMs 150`.

**Settings → Voice** writes the same `auxiliary.asr.*` / `auxiliary.tts.*` keys the
YAML above sets (`apps/web-api/src/repositories/config.repository.ts` maps them
one-for-one). It does **not** expose `command`, so `command-stt` / `command-tts` must
be configured by hand in `config.yaml`. There is also a **Test TTS** button there
that synthesizes a fixed phrase — a one-click check that the provider works.

#### Telegram — voice note in, voice note out

With a bot token configured, run `ethos gateway`.

- **In:** send a voice note. `transcribeAudioAttachments` reads the cached bytes and
  calls `transcribeBuffer`; the transcript is appended to the turn text. A failed or
  hallucinated transcript degrades to `(voice message)` rather than failing the turn.
- **Out:** after the text reply is delivered, `shouldReplyWithVoice()` decides. The
  per-lane default is `mirror_inbound` — it speaks back when you spoke to it. Change
  it in-chat with `/voice off|mirror_inbound|all`.
- The reply text is run through `sanitizeForSpeech`, truncated at a sentence boundary
  if the provider declares `maxInputChars`, then synthesized. Format `opus` goes out
  via `sendVoice`; `mp3` / `wav` go via `sendAudio` as `reply.<ext>`. **Telegram is
  the only adapter with `sendVoice` / `sendAudio`** — every other channel is text-only
  today.
- TTS failure is swallowed on purpose: the text was already delivered.

---

## 3. Privacy — arming the local-only egress gate

One key turns "no audio leaves this machine" from a habit into a rule:

```yaml
voice.trustedPlugins:
```

**Declaring the key at all arms the gate.** An empty value means *local providers
only*. Providers advertising `caps.local` (`local-stt`, `local-tts`, `command-stt`,
`command-tts`) always pass; every other provider must be named:

```yaml
voice.trustedPlugins: openai-tts, elevenlabs
```

Omitting the key entirely leaves the gate **off** — which is why an empty list is a
meaningful value and not the same as absence.

The refusal, verbatim from `packages/core/src/providers/voice-resolution.ts`:

```
TTS provider "openai-tts" is not local and is not in voice.trustedPlugins — refusing to send audio off this machine
```

It fires at *resolution*, before the provider is ever handed a byte, and it fires on
every surface because they all resolve through the same two functions:

- gateway (`extensions/gateway/src/index.ts`) — voice notes in and out
- web-api `VoiceService` — browser transcribe/synthesize, **including a provider
  picked live in Settings → Voice**
- `buildVoiceStack` — the realtime session stack
- `ethos doctor` — reports it instead of hiding it

Proof:

```bash
pnpm vitest run \
  extensions/gateway/src/__tests__/voice-trust-gate.test.ts \
  packages/core/src/__tests__/voice-resolution.test.ts \
  packages/config/src/__tests__/config-voice-trusted-plugins.test.ts \
  packages/wiring/src/__tests__/voice-stack.test.ts
```

Manual check: set `voice.trustedPlugins:` (empty) and `auxiliary.tts.provider:
openai-tts`, then run `ethos doctor`. The TTS line turns red with the refusal above.

In the UI: **Settings → Voice → Restrict voice egress** arms the gate and edits the
allowlist. The switch off deletes the key (gate off); the switch on writes the
providers you list. The declared-but-EMPTY form above is the one shape Settings
cannot write — the web config writer drops an empty value — so set that line by
hand if you want "trust nothing non-local".

---

## 4. Per-personality voice

`PersonalityConfig.voice` is set with dotted keys in a personality's `config.yaml`
(`~/.ethos/personalities/<id>/config.yaml`):

```yaml
name: Talker
description: Speaks first, thinks second
model: claude-sonnet-4-5
voice.tts_voice: af_bella
voice.tier: pipeline
voice.model: claude-haiku-4-5
voice.languages.es: ef_dora
voice.languages.ja: jf_alpha
```

- `voice.tts_voice` — the voice id handed to the TTS provider. Free-form; it is
  whatever your server calls it.
- `voice.tier` — `pipeline` or `realtime`. An unknown value is **dropped**, not
  thrown on: a bad voice id must not make a personality unloadable.
- `voice.model` — a fast-lane model for spoken turns.
- `voice.languages.<BCP-47 tag>` — per-language voice override.

Precedence (`resolveVoicePreferences`, `packages/core/src/providers/voice-resolution.ts`):

```
voice.languages.<tag>  >  voice.tts_voice  >  auxiliary.tts.voice (global)
```

Confirm it parsed:

```bash
ethos personality show talker
```

`renderCharacterSheet()` emits a `## Voice` block — TTS voice, the language map,
tier, fast-lane model — and omits the section entirely when the personality declares
no `voice` block.

```
## Voice
- TTS voice: af_bella
- ...
- Tier: pipeline
- Fast-lane model: claude-haiku-4-5
```

> **Which surfaces honor this today.** All three: the `VoiceSession` stack built
> by `buildVoiceStack`, channel replies through the gateway, and browser
> talk-mode. Every one of them resolves through the same
> `resolveVoicePreferences`, so "which voice served this reply" has one answer.
>
> - **Channel voice notes / replies** — the gateway reads the personality's
>   `voice` block through the optional `personalityDirectory.voice(id)` seam
>   (wired in `apps/ethos/src/commands/gateway.ts`) and passes the resolved
>   voice to `tts.synthesize`. The gateway has no per-turn language signal, so
>   the language rung is unused there and the personality's default voice wins.
> - **Browser talk-mode and the Play button** — the client sends `personalityId`
>   (and, where known, `language`) alongside the global voice it read from
>   Settings; `VoiceService` applies the precedence server-side. The global
>   value the client sends is the *lowest* rung, so a personality's declared
>   voice is heard over it rather than being overridden by it.
>
> Proof, asserting what the TTS provider actually received:
>
> ```bash
> pnpm vitest run \
>   extensions/gateway/src/__tests__/voice-personality-voice.test.ts \
>   apps/web-api/src/services/__tests__/voice-personality-voice.test.ts \
>   apps/web-api/src/voice/__tests__/voice-lane.test.ts \
>   apps/web/src/features/voice/__tests__/streaming-voice-call-client.test.ts
> ```
>
> Still on the global voice: the **`Play` button** on an assistant bubble
> (`apps/web/src/components/chat/PlayButton.tsx` calls
> `rpc.voice.synthesize({ text })` with no `personalityId`). The RPC accepts the
> field; the button does not yet pass it.

---

## 4b. The realtime tier

The second voice tier shipped: one hosted speech-to-speech session owns hearing,
thinking and speaking, instead of STT → agent turn → TTS. Browser talk-mode holds
the provider socket itself, opened with a credential the server minted; the app
keeps a second **control** socket for transcripts, `agent_consult`, cost accrual
and the turn-latency report.

### Configuring it

```yaml
voice.realtime.providers.live.provider: openai-realtime
voice.realtime.providers.live.model: gpt-realtime
voice.realtime.providers.live.apiKey: ${secrets:voice/realtime/providers/live/apiKey}
voice.realtime.providers.live.costPerMinuteUsd: 0.06
voice.realtime.default: live
voice.realtime.sessionBudgetUsd: 1.50
voice.tier: realtime
```

`live` is a label the operator chose, not a provider id — the egress gate keys on
the entry's `provider` and the constructed provider's `caps.local`, so calling an
entry `local-anything` buys nothing. Settings → Voice edits every key above. The
full field reference is
[`docs/content/using/reference/config-yaml.md`](docs/content/using/reference/config-yaml.md#voice-realtime-providers).

Two providers are registered (`extensions/voice-providers/src/realtime-registry.ts`):
`openai-realtime` and `gemini-live`.

### Gemini Live is contract-only — stated as a limitation

`gemini-live` exists to prove the provider contract is **not OpenAI-shaped**: a
different wire vocabulary, and 16 kHz in / 24 kHz out against OpenAI's 24/24. It
is exercised by the shared conformance suite like any other provider.

It declares `caps.ephemeralToken: false` (`extensions/voice-providers/src/realtime-gemini.ts`),
so `VoiceService.mintRealtimeToken` refuses with `no_browser_token` and the call
continues on the pipeline tier behind a visible notice. **There is no server-relay
path in this phase** — nothing in `apps/web-api` opens a Gemini session on the
browser's behalf. Selecting it as your realtime default means every browser call
falls back to the pipeline, by design, and says so on screen. Do not read the
"server-relayed" wording in the provider header as a shipped feature.

### What is covered automatically

Everything below runs against fakes — no credential, no socket, nothing that
leaves the machine. The one command that runs all of it is in
[§1](#the-suites-worth-knowing-by-name).

| Suite | Pins |
|---|---|
| `packages/types/src/__tests__/voice-realtime.test.ts` | `REALTIME_CONTRACT_VERSION`, the single audio format, exhaustive handling of every `RealtimeEvent` variant, and that the contract is implementable — including by a provider that omits both optional methods |
| `extensions/voice-providers/src/realtime-conformance.ts` | The shared suite itself — the 11 checks in `REALTIME_CONTRACT_CHECKS`, from "caps and provider shape" to "audio supplied at the declared INPUT sample rate reaches the wire unresampled" |
| `extensions/voice-providers/src/__tests__/realtime-contract.test.ts` | Those 11 checks run per **registered** provider, via `describe.each(registry.list())`. A provider added to the registry without a conformance target fails the coverage guard rather than shipping untested |
| `realtime-openai.test.ts` · `realtime-gemini.test.ts` | Per-provider detail that is not contract: model pinning, headers, handshake shape |
| `realtime-registry.test.ts` | That both built-ins register under their configured ids, and that each declares the sample rates it actually speaks |
| `realtime-fake.test.ts` | `extensions/voice-providers/src/realtime-fake.ts` — the one provider-level fake, shared by the conformance harness and the mock bench, so the thing the tests drive and the thing the bench drives are the same thing |
| `packages/voice-realtime-protocol/src/__tests__/browser-safety.test.ts` | That nothing reachable from the browser entry points imports `ws` or a `node:` builtin — the frame mapping is shared verbatim between browser and server |
| `packages/core/src/__tests__/voice-realtime-roster-resolution.test.ts` | Roster selection and the egress gate keying on the **resolved provider**, never the roster label |
| `apps/web-api/src/services/__tests__/voice-realtime-token.test.ts` | Every typed refusal — `not_configured`, `unknown_entry`, `untrusted_provider`, `no_browser_token`, `provider_unavailable`, `pipeline_preferred` — and that no refusal message carries key material |
| `...voice-realtime-session-config.test.ts` | What is baked into the credential before the mint: the personality's identity plus the boundary policy as instructions, the advertised tool list, and the voice — the personality's beating the roster entry's. A surface that throws leaves a usable session rather than taking the call down |
| `...voice-realtime-session-cost.test.ts` | Per-minute rate selection from the entry the mint would pick; an unpriced entry reported as unpriced, never as free |
| `extensions/tools-voice/src/__tests__/realtime-host.test.ts` | **advertised == handled** — every advertised tool definition is dispatched, and a name never advertised is refused rather than left hanging |
| `apps/web-api/src/voice/__tests__/realtime-control-lane.test.ts` | No dead air over 2s during a slow consult, strict FIFO consults, per-minute accrual tick by tick, a wind-down that speaks then closes in that order, and provider-stamped latency spans |
| `...realtime-control-deps.test.ts` | Lane keying `voice:<botKey>:browser:<id>`, resumed on reconnect, never interleaved with the typed chat in the same browser session |
| `apps/web/src/features/voice/__tests__/realtime-voice-call-client.test.ts` | The browser's provider link: the token carried in a subprotocol with no handshake of its own, capture at the provider's input rate, playout at its output rate, barge-in keeping the honestly-spoken prefix, an expired credential re-minted rather than redialled, and the backoff schedule spent once before degrading to text |
| `realtime-control-channel.test.ts` | The control socket, including the `realtime_turn_latency` report |
| `talk-mode-client.test.ts` | Tier selection, and the pin that `no_browser_token` is **never a silent downgrade** |
| `voice-call-reducer.test.ts` | Call state and the `[interrupted]` marker shared by history and screen |
| `call-strip.test.ts` · `call-strip-css.test.ts` · `call-strip-layout.test.ts` | The DR5 contract: ≥44px touch targets, `prefers-reduced-motion` stopping every pulse, and the caption staying on screen at 375px instead of being traded for the fit |
| `mic-meter.test.ts` | That reduced motion stops the meter bars in JS — the stylesheet cannot, because the bars are redrawn every frame |

The wire contract for the browser's latency report is `RealtimeTurnLatencySchema`
in `packages/web-contracts/src/voice-socket.ts`.

### What needs credentials, and what only a human can check

**Nothing in CI touches any of this.**

An **OpenAI key with Realtime access** plus a `voice.realtime.providers.<name>`
entry is the only path that mints a real browser credential and opens a real
provider socket. Everything in the table above uses fakes. Gemini Live cannot be
exercised from a browser at all, by design (above).

Manual only, because no fake can stand in:

- **Real mic and speakers.** Capture at the provider's own input rate (24 kHz for
  OpenAI Realtime, 16 kHz for Gemini Live — nothing resamples), absolute-time
  playout, audible barge-in, the thinking earcon, and the screen wake lock.
- **A real network blip on a phone.** Two independent socket backoffs: the app
  lane repeats its last delay forever, the provider socket walks the schedule once
  and then degrades to text.
- **Real mouth-to-ear.** `pnpm bench:voice:live:realtime`, or a deployment's own
  `realtime_first_audio` spans. The mock bench "exercises the measurement path,
  not a provider" — its own words, printed on every run.
- **A real per-minute invoice**, reconciled against the accrued cost. The rate is
  a number the operator typed; nothing verifies it against the provider's bill.

### One honest measurement limit

A deployed realtime turn writes exactly one span: `realtime_first_audio`, the
browser's own measurement of last speech frame → first audio frame. The budget
module reads it as mouth-to-ear. **`endpoint` is absent and unmeasurable** — the
provider owns the VAD and never reports when it decided — so the endpointing sits
*inside* the reported number, making it an upper bound. The browser's own capture
and playout legs sit outside it and are simply not measured.

---

## 5. What needs credentials or hardware you supply

| Capability | You must provide | How to verify | Already proven against fakes |
|---|---|---|---|
| Server STT (`local-stt`) | A running OpenAI-compatible Whisper server | `curl -sI http://localhost:8000/v1/models`, then the mic button in web chat | `extensions/voice-providers/src/__tests__/local-providers.test.ts`, `openai-compat.test.ts` |
| Server TTS (`local-tts`) | A running Kokoro-style server | Settings → Voice → **Test TTS**, or the Play button | same as above |
| Binary STT/TTS (`command-*`) | Real `whisper-cli` / Piper / `say` on `PATH` | Run your template by hand first, then `ethos doctor` | `extensions/voice-providers/src/__tests__/command-providers.test.ts` (template substitution, temp-file lifetime, `command` required) |
| Cloud STT/TTS (`openai-stt`, `groq-stt`, `openai-tts`) | Real API keys — and an entry in `voice.trustedPlugins` if the gate is armed | `ethos doctor` shows `(remote)`; a turn produces audio | Resolution, trust gate and HTTP shaping are tested; the live endpoints are not called |
| Batch STT over a generated WAV | A real batch STT server that accepts the utterance-buffered WAV | Talk-mode against a batch-only provider | `extensions/voice-session/src/__tests__/wav.test.ts`, `buffered-stt.test.ts` — encoder correctness only, no server ever consumes the bytes |
| Browser realtime tier (`openai-realtime`) | An OpenAI key with Realtime access, a `voice.realtime.providers.<name>` entry, and a place in `voice.trustedPlugins` if the gate is armed | Start talk-mode; the strip's detail row names the realtime provider and model that served the call | Mint, refusals, control lane, cost and the browser link are all tested against fakes ([§4b](#4b-the-realtime-tier)); no socket is ever opened |
| Browser realtime tier (`gemini-live`) | Nothing will make this work in a browser | Not possible — `caps.ephemeralToken: false`, so the mint refuses `no_browser_token` and the call falls back to the pipeline with a visible notice. Deliberate; see [§4b](#4b-the-realtime-tier) | The refusal itself is pinned, on both the server and browser sides |
| LiveKit transport | `@livekit/rtc-node` + `livekit-server-sdk` (**not repo dependencies**), a LiveKit server, and app-layer `LiveKitBindings` | Manual only — see `extensions/platform-voice/README.md` | `extensions/platform-voice/src/__tests__/` against fake room clients |
| Telephony (`call`, inbound SIP) | A SIP trunk, a rented E.164 number, a `SipTrunkClient` implementation | Manual only | `extensions/tools-voice/src/__tests__/call.test.ts`; `call` self-reports unavailable with no trunk, and is in `APPROVAL_SURFACE_ALWAYS_ASK` so it always prompts |
| Telegram voice notes | A bot token | Send a voice note to the bot with `ethos gateway` running | `extensions/gateway/src/__tests__/voice-pipeline.test.ts` |

Manual-verification list, condensed: **LiveKit native bindings, a SIP trunk plus a
rented number, real cloud STT/TTS keys, a real OpenAI Realtime key, real
`command-*` binaries, and a real batch STT server consuming the generated WAV.**
Nothing in CI touches any of these.

---

## 6. Known gaps / not yet built

Do not go hunting for these. They do not exist on this branch.

### 1. Streaming TTS on the browser surface
`local-tts` and `openai-tts` now implement `synthesizeStream` and declare
`caps.streaming`, and `VoiceSession` uses it: audio is emitted chunk-by-chunk as the
`/v1/audio/speech` response streams, and sentence N+1 is synthesized while N is
still playing (`extensions/voice-session/src/playout-queue.ts`). A provider without
`caps.streaming` still takes the batch path unchanged.

What is NOT wired: **browser talk-mode does not use it.** Talk-mode calls the
`voice.synthesize` RPC, which returns one base64 blob per sentence — the streaming
path only runs on the `VoiceSession` stack. `command-tts`, `openai-stt`, `groq-stt`,
`local-stt` and `command-stt` remain batch-only.

### 2. Binary-PCM WebSocket + WebAudio playout — now the default
Browser talk-mode opens **one persistent WebSocket** at `GET /voice/ws` and carries
binary frames both ways: mic PCM up, synthesized audio down. No base64, no JSON
audio bodies, no per-utterance HTTP. Playout is `AbsolutePlayout` (WebAudio),
which schedules each buffer where the previous one ended on the audio clock.

The batch RPC path is still there and still works — `talk-mode-client.ts` falls
back to it when a browser lacks `WebSocket`, `AudioContext`, `getUserMedia` or
`createScriptProcessor` (and on `forceBatch`). Both paths emit the same events,
so the UI is identical.

Two honest limits:

- **Sentence-granular, not frame-granular, for container codecs.** `local-tts` and
  `openai-tts` emit opus; a mid-stream opus slice is not independently decodable,
  so the lane tags those frames `codec: 'encoded'` and the browser decodes each
  SEGMENT (one sentence) at `segment_end`. A provider that emits `pcm` gets true
  frame-by-frame playout. First audio still starts long before the reply finishes.
- **No resampling.** The mic's PCM goes up at the `AudioContext`'s own rate
  (typically 48 kHz) and the lane wraps it in a WAV header for the STT provider.

Proof: `apps/web-api/src/voice/__tests__/`, `apps/web/src/features/voice/__tests__/`
(`webaudio-playout`, `voice-socket-transport`, `pcm-endpointer`,
`streaming-voice-call-client`, `talk-mode-client`, `wake-lock`).

Manual verification still needed (nothing in CI drives real audio): a real mic in a
real browser, a real STT/TTS server behind it, and the reconnect + wake-lock paths
on a phone.

### 3. Personality voice — wired everywhere except the Play button
`resolveVoicePreferences` used to have exactly one consumer
(`packages/wiring/src/voice-stack.ts`), so a personality's `voice.tts_voice`
changed its character sheet and nothing you could hear on the two surfaces most
people reach first. It now has three:

- `packages/wiring/src/voice-stack.ts` — the `VoiceSession` stack;
- `extensions/gateway/src/index.ts` — channel replies, via the optional
  `personalityDirectory.voice(id)` seam;
- `apps/web-api/src/services/voice.service.ts` — the browser `synthesize` RPC
  **and** the binary WS lane, from the `personalityId` the client now sends.

Precedence is the same everywhere because it is the same function:
`voice.languages.<tag>` > `voice.tts_voice` > global `auxiliary.tts.voice`.

What remains: the **Play button** does not send `personalityId`, so a
click-to-hear on an assistant bubble still uses the global voice. The gateway
has no per-turn language detection, so `voice.languages.*` cannot select there
yet — the personality's default voice is used instead of a wrong-language one.

Two related caveats on the `VoiceSession` stack itself, both from the source:
the LiveKit and SIP transports additionally require app-supplied native
bindings, which **no in-repo caller passes yet** (`build-agent-loop.ts:969-970`),
and nothing in-repo currently reads `result.voiceStack` to drive a live
session — you hold the stack and call `createSession()` yourself.

### 4. Two list-valued config keys are still unreachable
`auxiliary.tts.outputFormat`, `auxiliary.tts.timeout`, `auxiliary.tts.maxTextLength`
and `auxiliary.asr.timeout` used to be matched by the parser and then dropped — the
factories read them, nothing supplied them. They are lifted now: parser →
`EthosConfig` → `providerConfigFrom()` → the provider (`packages/config/src/index.ts`,
`packages/wiring/src/voice-stack.ts`, `packages/wiring/src/build-agent-loop.ts`).
A garbage value (`timeout: soon`, `outputFormat: flac`) is dropped, so the provider
default stands.

Still unreachable, deliberately: `auxiliary.tts.voices` and `auxiliary.asr.languages`.
Both are lists, and the flat `key: value` parser has no list encoding for them; both
only populate advisory `caps.voices` / `caps.languages`, which nothing in the repo
enforces. They are documented nowhere — do not write them expecting an effect.

### 5. CallStrip shipped; per-personality voice editor still config-file only
The talk-mode UI is the CallStrip (`apps/web/src/features/voice/TalkMode.tsx`):
nine states — connecting, listening, thinking/consulting, speaking, barge-in,
reconnecting, degraded-to-text, mic-permission-denied, plus the idle entry points
— with a live caption line and the `{provider} · {model}` mono label. See
DESIGN.md § CallStrip.

The realtime tier added three renderings on top of those nine, none of which is a
new state word:

- **A tier notice above a live strip.** Realtime was refused or dropped and the
  call is continuing on the pipeline. Dismissible, and never silent — unlike
  `degraded`, which replaces the strip, this one sits above a working call.
- **A `budget reached` mono chip** beside the state word during the spoken
  wind-down, with the sign-off as the caption.
- **A realtime detail row.** `{realtime provider} · {model}` (one provider serves
  the whole turn, so there is no STT/TTS pair to show) plus a `use private mode`
  control that takes the call to the pipeline deliberately.

Settings → Voice now edits every voice key the plans introduced, including
`voice.trustedPlugins`, `voice.defaultMode`, and the `auxiliary.*` timeouts and
output format. One edge stays config-file only: an allowlist that is **declared
but empty** (`voice.trustedPlugins:` with no value) arms the gate with nothing
trusted. Settings treats an empty list as "gate off" because the web config
writer cannot round-trip an empty value; write that line by hand if you want it.

A personality's own `voice.*` block (`tts_voice`, `languages`, `tier`, `model`)
is still edited in the personality's `config.yaml` and rendered read-only in the
character sheet — there is no web editor for it.

`voice.tier` now has a consumer: `VoiceService.mintRealtimeToken`
(`apps/web-api/src/services/voice.service.ts`) runs it through
`resolveVoicePreferences` against the deployment's `voice.tier`, and an explicit
`pipeline` refuses the mint with `pipeline_preferred`. Absent from both means
"try realtime". The global default is editable in Settings → Voice.

`voice.model` — the fast-lane model for spoken turns — still has **no consumer**.
`resolveVoicePreferences` resolves and returns it, and nothing reads the result;
no caller even passes the `globalModel` option. The realtime tier does not use it:
a realtime call's model comes from the roster entry (`selection.entry.model` in
`mintRealtimeToken`), not from the personality's `voice.model`. Fast-lane routing
for pipeline turns has not landed.

### 6. Built-in `voice` personality — shipped
`extensions/personalities/data/voice/` is the first built-in that lists
`voice_session`, so talk-mode's phone button is enabled for it out of the box.
It declares `voice.tts_voice: af_bella`, `voice.tier: pipeline`, a fast-lane
`voice.model`, and a Spanish entry in its language map; its toolset carries
nothing that writes to disk or runs a shell (consequential work leaves the
spoken lane through `delegate_task`).

Its static prompt is budget-gated at ~2k tokens (latency decision L5) by
`extensions/personalities/src/__tests__/voice-personality.test.ts` — SOUL.md
plus the spoken-style injector measure ~2.3k chars / ~580 tokens today, so
there is headroom, and the test is what stops it being spent silently.

### 7. Not built at all
Channel TTS-out beyond Telegram and the ffmpeg transcode stage; the wake-word
satellite; telephony beyond the typed seams. `shouldReplyWithVoice` accepts a
`wakeTriggered` flag that nothing sets yet.

The realtime tier itself shipped ([§4b](#4b-the-realtime-tier)). Two things inside
it did not: a **server-relay path**, so `gemini-live` is contract-only and cannot
serve a browser call; and a **fast-lane model** for spoken pipeline turns, so
`voice.model` on a personality still resolves to nothing.

---

## 6b. Latency — the bench

Two tiers, two modes, one module
(`extensions/voice-session/src/latency-budget.ts`).

Pipeline tier (`VOICE_LATENCY_BUDGET_MS`):

| Stage | Budget | What it covers |
|---|---|---|
| `endpoint` | ≤300ms | Last speech frame → the turn starting. Includes the configured silence threshold. |
| `stt` | ≤200ms | Committed audio → final transcript. |
| `llm_first_sentence` | ≤800ms | Transcript → first sentence handed to synthesis. |
| `tts_first_audio` | ≤300ms | First sentence → first audio frame out. |
| `pipeline` | ≤1600ms | Mouth to ear. |

Realtime tier (`VOICE_REALTIME_LATENCY_BUDGET_MS`) — three stages, because one
hosted session owns hearing, thinking and speaking and reports one moment:

| Stage | Budget | What it covers |
|---|---|---|
| `endpoint` | ≤300ms | Same human fact as above, but the threshold belongs to the **provider's** server VAD (500ms by default on OpenAI Realtime), which no deployment setting can shorten. A live run will normally miss this and still make the total. The number is printed, not moved to fit. |
| `realtime_first_audio` | ≤500ms | What is left for the hosted session to think and start speaking. Separable only when the provider marks the commit before its first audio; several transcribe asynchronously and do not, and then the endpointing is inside this stage. The bench reports which case it saw. |
| `pipeline` | ≤800ms | Mouth to ear. The only stage measured **directly** on this tier, and the reason the tier exists. |

```bash
pnpm bench:voice                  # pipeline tier, mock providers, no credentials
pnpm bench:voice:realtime         # realtime tier, shared fake provider, no credentials
pnpm bench:voice:live             # pipeline tier against ~/.ethos/config.yaml
pnpm bench:voice:live:realtime    # realtime tier against a configured roster entry + key
```

`pnpm bench:voice:realtime` verified here — 5 turns, all three stages PASS:

```
  Stage                 p50    p90    p99    Budget   Result
  --------------------  -----  -----  -----  -------  ------
  endpoint              254ms  261ms  261ms  ≤ 300ms  PASS
  realtime_first_audio  360ms  363ms  363ms  ≤ 500ms  PASS
  pipeline              614ms  615ms  615ms  ≤ 800ms  PASS
```

The mock timings come from `--realtime-commit-ms` / `--realtime-audio-ms`, so
that run "exercises the measurement path, not a provider" — the script's own
words, printed under the table. A real number needs
`pnpm bench:voice:live:realtime` (a roster entry and a key) or a deployment's own
`realtime_first_audio` spans.

Both pipeline modes drive a real `VoiceSession` and read the **per-turn spans it
writes** — the same telemetry a deployment sees — so the bench cannot report a
number the product does not. The realtime modes drive a real `RealtimeSession`
(the shared fake provider, or the configured one) and build the same
`realtime_first_audio` span a deployed call writes. Live mode adds `--turns=N`
(default 10) and reports p50/p90/p99 per stage; budgets are checked against
**p90** on both tiers. `--assert-budget` exits non-zero on a miss.

Because the spans are cumulative from the turn start, the arithmetic that turns
them into stage-owned time lives in `latency-budget.ts` and is unit-tested
(`extensions/voice-session/src/__tests__/latency-budget.test.ts`) — `scripts/`
is outside the vitest globs, so a budget implemented only in the script would be
a budget nobody checks.

Live mode measures STT and TTS against the **real configured providers**,
resolved through the same functions (and the same egress gate) every surface
uses. The LLM is deliberately a fixed reply so model variance stays out of the
TTS numbers. Without `--audio=<file.wav>` the bench feeds a synthetic tone: a
real transcriber returns nothing for it, so only the STT stage is reported. Pass
a recorded 16-bit PCM WAV of someone speaking to get the whole pipeline.

`--endpoint-silence-ms=N` (default 250) sets how much silence the detector waits
for. It is part of endpoint latency by definition, so a threshold at or above
300ms can never meet the endpoint budget.

---

## 7. Troubleshooting

**No audio out at all.**
Run `ethos doctor` first — it answers this in one line.
- `– TTS not configured.` → no `auxiliary.tts.provider`.
- `✗ TTS: … refusing to send audio off this machine` → `voice.trustedPlugins` is
  armed and your provider is not local. Add its id to the list, or switch to
  `local-tts` / `command-tts`.
- `✗ TTS: Unknown TTS provider "…" — not registered` → typo. Valid ids:
  `openai-tts`, `local-tts`, `command-tts` (STT: `openai-stt`, `groq-stt`,
  `local-stt`, `command-stt`).
- `✗ TTS: … failed to initialize: command-tts requires a command template` → you
  selected `command-tts` without setting `auxiliary.tts.command`.
- Doctor green but still silent → the provider resolves but the server is down.
  Doctor makes no network calls. `curl` the `baseUrl`. On `command-tts`, run your
  template by hand and check the output file is non-empty — `say -o out.mp3` writes a
  16-byte silent file without erroring.

**Play button missing on assistant messages.**
It renders on the server-reported `voice_tts` capability, which is `auxiliary.tts.provider`
being set. Set it, then reload — restart `ethos serve` after editing `config.yaml`.

**Empty transcripts / "Could not transcribe audio — try again".**
Two different causes, same message:
1. *Format mismatch.* The MIME type the browser or channel sends is passed straight to
   the provider. `command-stt` picks the temp-file extension from that MIME
   (`AUDIO_EXT_BY_MIME`, defaulting to `wav`) and CLI transcribers sniff the container
   from the suffix — an honest MIME matters. Server-backed providers just forward the
   bytes; if the server rejects the container, you get an empty result.
2. *The hallucination filter dropped it.* `isHallucination()` discards known STT
   phantoms on silence or noise: "thanks for watching", "please subscribe", a lone
   "you", `[music]`, `...`, and any short phrase repeated three or more times. That is
   working as designed — but it means a genuinely quiet recording looks identical to a
   failure. Speak louder/longer and retry before suspecting the provider.

**Talk-mode phone button greyed out.**
The personality's toolset does not list `voice_session`. The tooltip says so. Add it to
`~/.ethos/personalities/<id>/toolset.yaml`; personalities hot-reload, no restart.

**Talk-mode connects but never hears you / cuts you off mid-sentence.**
Tune it live in **Settings → Voice → Advanced**. Raise `endpointSilenceMs` if it ends
your utterance too early; raise `speechThreshold` if room noise keeps triggering;
raise `bargeThreshold` / `bargeSustainMs` if the agent's own playout is echoing back
and interrupting itself.

**Tests time out at 15s on a busy machine.**
`vitest.config.ts` sets `testTimeout: 15_000` with `retry: 0` locally. Under load — a
full `pnpm test` alongside a build, or a heavily loaded laptop — mock-heavy suites
*unrelated to voice* can blow that budget purely from transform and worker contention.
**Re-run the failing file in isolation before believing you found a regression:**

```bash
pnpm vitest run <the-one-failing-file>
```

If it passes alone, it was load. If it fails alone, it is real.

---

## See also

- `docs/content/using/how-to/local-voice.md` — the canonical local-server recipe
- `docs/content/using/reference/config-yaml.md` — every `voice.*` config key,
  including the realtime roster, `voice.tier` and the per-session budget
- `docs/content/using/reference/personality-yaml.md` — the personality's own
  `voice.*` block
- `apps/web/src/features/voice/README.md` — the browser tiers, both transports,
  and what only a human can verify
- `extensions/voice-providers/src/template/` — scaffold for a third-party provider
- `extensions/voice-providers/src/conformance.ts` — `validateSttProvider` /
  `validateTtsProvider`; a provider that passes these is callable by every surface
- `extensions/voice-providers/src/realtime-conformance.ts` — the 11-check realtime
  contract suite every registered realtime provider is run through
