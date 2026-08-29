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
| Voice notes over channels | A bot token for the channel in `~/.ethos/config.yaml`, plus `ffmpeg` on `PATH` for anything the TTS provider does not already emit in a declared format |
| Wake satellite (`ethos listen`) | `ethos serve` running and a PCM pipe — `ffmpeg` or `arecord`. No `voice.wake.routes` entry needed; the server synthesizes one per unprivileged personality. **Open mic: the server transcribes everything and matches the wake phrase there** — see [The flows to try](#the-flows-to-try) |
| Acoustic wake (`sherpa`) | `sherpa-onnx-node` installed by hand (**not a repo dependency**) plus four model files in `~/.ethos/models/wake/`. No host in this repo has ever run it |
| Telephony (inbound + outbound calls) | A LiveKit server with SIP, a trunk, a rented number, and a public URL for the webhook. The decision path — verify, gate, screen, log, summarise — runs against fakes with none of them; see [4c. Telephony](#4c-telephony) |
| Audio on a call | `@livekit/rtc-node` installed on the gateway host (**not a repo dependency** — a per-arch native binary). Without it a call is answered, gated, logged and summarised, and carries no voice |

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

The wake stack — satellite package, node protocol, the `/satellite/ws` lane,
`ethos listen`, the desktop host, and the Settings surfaces:

```bash
pnpm vitest run \
  extensions/voice-satellite/src \
  packages/web-contracts/src/__tests__/satellite-socket.test.ts \
  packages/core/src/__tests__/lane-key.test.ts \
  apps/web-api/src/voice/__tests__/satellite-socket.test.ts \
  apps/web-api/src/voice/__tests__/implicit-wake-routes.test.ts \
  apps/web-api/src/voice/__tests__/wake-privilege.test.ts \
  apps/web-api/src/__tests__/services/config-wake-routes.test.ts \
  apps/ethos/src/__tests__/listen-command.test.ts \
  apps/ethos/src/__tests__/listen-doctor.test.ts \
  apps/ethos/src/__tests__/listen-node-id.test.ts \
  apps/ethos/src/__tests__/listen-capture-device.test.ts \
  apps/desktop/src/main/__tests__/satellite.test.ts \
  apps/web/src/features/voice/__tests__/wake-routes.test.ts \
  apps/web/src/features/voice/__tests__/wake-route-row.test.ts \
  apps/web/src/features/voice/__tests__/satellite-rows.test.ts
```

Verified: 18 files, 248 tests, ~3.2s. No microphone, no model file, no native
binding — every device and socket is injected.

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
| `extensions/voice-satellite/src/__tests__/capture.test.ts` | The supervised capture machine: five consecutive wake → capture → speak → re-arm cycles, self-wake suppression (frames never reach the engine while speaking or thinking), the playback watchdog force-re-arming and reporting `degraded`, the idle timeout ending LISTENING **only**, and two machines in one process staying independent |
| `extensions/voice-satellite/src/__tests__/doctor.test.ts` | That `runSatelliteDoctor` never throws — a throwing engine probe becomes a row, a missing model directory is named, an unrun probe is `skipped` rather than passed on a guess, and the absent `sherpa-onnx-node` peer is reported unavailable with the reason |
| `extensions/voice-satellite/src/__tests__/transcript-wake-engine.test.ts` | The transcript matcher: phrase at the **head** of the utterance, one-character tolerance that widens with sensitivity, longest-phrase-wins, disabled routes never matching, `privileged` never inferred, and `push()` on raw PCM always returning null. The greeting rule itself (a leading `hey` optional on both the route phrase and the utterance, and a two-letter name matching only exactly) is pinned in `packages/voice-text/src/__tests__/wake-match.test.ts` |
| `extensions/voice-satellite/src/__tests__/node-client.test.ts` | The node protocol client: register under the stable `nodeId`, capped jittered reconnect backoff, re-register on reconnect, malformed server frames dropped rather than thrown on, and the audio/`transcript` alternation refused if a node tries both for one utterance |
| `apps/web-api/src/voice/__tests__/satellite-socket.test.ts` | The `/satellite/ws` upgrade policy (path, Origin, `ethos_auth` cookie, no-Origin daemons allowed), one real `ws` round trip, and the **server-side phrase gate**: a matched transcript runs on the MATCHED personality with the phrase stripped, an unmatched one runs no turn and calls no model, a `phraseMatch: true` node is not double-gated, a matched privileged personality without opt-in is refused, follow-ups inside the addressing window continue without a phrase and stop outside it, a different phrase switches personality and lane while each keeps its history (D15), and a reconnect drops the window but not the session |
| `apps/web-api/src/voice/__tests__/implicit-wake-routes.test.ts` | The synthesized bare-name table: privileged personalities get nothing, a configured route (even a disabled one) suppresses the implicit one, a phrase is claimed once (compared with the greeting stripped, so `hey engineer` and `engineer` are one claim), and ties break by personality id |
| `apps/web-api/src/voice/__tests__/wake-privilege.test.ts` | That privilege is derived from the approval layer's own consequential-tool lists, and an **absent** toolset is privileged (fail-closed) |
| `apps/ethos/src/__tests__/listen-doctor.test.ts` | The 0 / 1 / 2 exit matrix, probe→flag derivation, URL derivation, and the false-available case (eng-review D10): a missing model reports unavailable, the host degrades, nothing crashes |
| `apps/ethos/src/__tests__/listen-command.test.ts` | That the daemon refuses to start deaf — no pipe, an unresolvable `--route` pin, or no usable engine each stop the boot rather than printing "listening" — the open-mic banner (everything transcribed, only a personality's name reaches an agent, follow-ups inside the window), the four closing lines a turn can end on (answered, refused, no speech, addressed to nobody) — each keyed to what happened to THAT utterance, so a refusal never closes with `not addressed to anyone` under the error explaining the refusal — and the `--json` shape including `daemonMode: "open-mic"` |
| `apps/desktop/src/main/__tests__/satellite.test.ts` | The doctor gate (no capture device → `degraded`, nothing starts), that no entry point throws, the routes-push arming path, and wake-off surviving a restart (Hermes #81531) |

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

#### Channels — voice note in, voice note out

With a bot token configured, run `ethos gateway start`.

- **In:** send a voice note. `transcribeAudioAttachments` normalizes the cached bytes
  to the STT provider's preferred container (ffmpeg, `wav` when the provider takes it)
  and calls `transcribeBuffer`; the transcript is appended to the turn text. Any
  failure — a throw, a typed error, or an empty string — retries once re-encoded from
  the original bytes as `wav`. A failed or hallucinated transcript degrades to
  `(voice message)` rather than failing the turn. **All four channel adapters** classify
  inbound audio as `type: 'audio'` and therefore reach STT — Telegram from `msg.voice`
  and `msg.audio`, Slack and Discord from the upload's extension or content type,
  WhatsApp from `audioMessage` (with the filename extension derived from the mimetype,
  so a push-to-talk opus memo and a forwarded mp3 both land in the right container).
  `.webm` stays classified as video on Slack and Discord and is not transcribed.
- **Out:** after the text reply is delivered, `shouldReplyWithVoice()` decides. The
  per-lane default is `mirror_inbound` — it speaks back when you spoke to it. Change
  it in-chat with `/voice off|mirror_inbound|all`; the mode is persisted by
  `LaneVoiceModeStore` (`packages/core`) to `~/.ethos/voice/lane-modes.json`, so it
  survives both `/new` and a gateway restart.
- The reply text is run through `sanitizeForSpeech`, truncated at a sentence boundary
  if the provider declares `maxInputChars`, then synthesized. **Which channels can
  speak is declared, not sniffed:** an adapter implements `sendVoiceNote` and declares
  `voiceCaps` (`packages/types/src/platform.ts`), and the gateway routes through
  `isVoiceOutboundAdapter`. All four of `platform-telegram`, `platform-slack`,
  `platform-discord` and `platform-whatsapp` declare caps today; a new adapter gets
  TTS-out by declaring them. The gateway transcodes the synthesized audio into the
  first format the sink declared — Telegram opus → `sendVoice` voice bubble, WhatsApp
  opus with `{ ptt: true }`, Discord an attached audio file, Slack a `files.uploadV2`
  with an inline player.
- **ffmpeg is optional.** Without it, a reply already in a declared format passes
  through and everything else is skipped with a `gateway.voice_format_unsupported`
  event rather than delivered as an unplayable blob. The gateway prints a one-line
  `⚠ ffmpeg not found` notice at startup.
- TTS failure is swallowed on purpose: the text was already delivered. A voice note
  that *was* synthesized but not confirmed is not lost — it is a `kind: 'voice'`
  obligation in the delivery ledger, and the sweep re-sends the stored artifact.

#### Wake satellite — `ethos listen`

`ethos serve` hosts the satellite lane at `GET /satellite/ws` (**not** the gateway —
web-api owns the WS server, the auth cookie, the AgentLoop and the personality
refresh, so a Settings save pushes routes in-process). Preflight first:

```bash
make listen-doctor
```

```
ethos listen doctor  wake satellite preflight

  ✓  engine:transcript      no native bindings and no model files — matches wake phrases against STT output
  ⚠  models                 not required by the 'transcript' engine — model directory missing — ~/.ethos/models/wake
  ✓  microphone             1 input device(s): raw s16le mono PCM on stdin @ 16000 Hz
  ⚠  satellite-lane         ws://127.0.0.1:3000/satellite/ws: connection refused (ECONNREFUSED) — nothing is listening there, so the server is not running. Start it with `ethos serve`.
  ✓  node id                pi-kitchen-f089dce2 (~/.ethos/listen-node-id)
  ✓  satellite url          ws://127.0.0.1:3000/satellite/ws
  –  route                  none configured here, which is normal. The effective table is the server's: it adds a bare-NAME route (auto:<personalityId>) for every unprivileged personality and pushes the merged table on connect, so what this host can reach is only knowable once it has connected.

⚠ Nothing is broken on this host, but it cannot listen right now.
```

That is the run with nothing on `:3000`. Start `ethos serve` and the same row goes
green: `✓ satellite-lane  ws://127.0.0.1:3000/satellite/ws is mounted — answered 401
to a probe sent with no auth cookie, which is the expected refusal`. The probe is a
real WebSocket upgrade against `/satellite/ws` sent with no cookie, so the refusal
*is* the pass and no phantom lane or registry row is created by checking. It is
deliberately **not** `/healthz`: that folds the channel gateway's status into its
own, so a healthy `ethos serve` with no chat bots attached answers 503 — and when
the doctor does fall back to it, a 503 whose body is `{status: 'degraded', gateway:
{status: 'down'}}` still reports `✓ reachable`, because a satellite does not use the
channel gateway for anything. A connection that never came up names its errno and
the remedy, as above, rather than undici's `fetch failed`.

`route` is a dim `–`, never a verdict — this command never connects, so it has
nothing to say about routing. **No `voice.wake.routes` entry is required to listen.**
The effective table is the server's, which synthesizes an `auto:<personalityId>`
route for every unprivileged personality, pushes the merged table on connect, and
matches transcripts against it; `--route <id>` is a PIN checked against that table
when `ethos listen` connects, not here.

Exit `0` clean, `1` hard (no config, no usable engine, missing models for a
`sherpa` host), `2` warn (no pipe attached yet, server not up yet — both true
*right now* and possibly not in a minute). `make listen-doctor` translates the warn
code to **0** so a recoverable run does not fail the build; exit `1` still does.
`--json` adds a machine-readable object whose `engine.daemonMode` is the honest
label: `"open-mic"`, alongside `engine.phraseMatch: false`.

**Capture is a pipe, and the gate is server-side.** `apps/ethos` ships no
microphone binding, and the only always-available engine (`transcript`) matches
wake phrases against *recognized text*, which this host does not produce. So the
daemon registers `phraseMatch: false`, speech onset on the pipe opens an utterance,
and the SERVER matches the transcript: an utterance that opens with a wake phrase
runs a turn as the personality that phrase names (the phrase is stripped), a
follow-up within `voice.wake.idleTimeout` continues with that personality, and
everything else is transcribed and discarded. **The room is transcribed either
way** — the gate protects the agent, not the microphone.

```bash
# macOS
ffmpeg -nostats -loglevel error -f avfoundation -i :0 -ar 16000 -ac 1 -f s16le - | ethos listen
# Linux
arecord -q -f S16_LE -r 16000 -c 1 -t raw | ethos listen
```

`--route <id>` is optional and PINS the microphone to one route: only that phrase
may address it, and another agent's phrase is discarded rather than answered.

Keep the quiet flags. Both processes share the terminal, and ffmpeg's
carriage-returned progress meter overwrites the daemon's own lines mid-word
(`› you: hello7.9kbits/s speed= 1x`). `-nostats -loglevel error` drops the
banner and the meter and nothing else — a bad device index still prints.

`make listen` prints the same two pipelines and then runs the daemon, so a bare
`make listen` on a TTY refuses to start — by design, and it says why.

What is manual-only here, because no fake can stand in:

- **A real pipe and a real room.** Sample-rate correctness is unverifiable by
  construction: raw PCM carries no header, so piping 44.1 kHz stereo produces
  garbage that nothing detects.
- **Acoustic wake.** It needs `sherpa-onnx-node` (a ~33 MB per-arch native binary,
  deliberately **not** a repo dependency) plus four model files. The adapter in
  `extensions/voice-satellite/src/engines/sherpa-wake-engine.ts` is written against
  sherpa's documented `KeywordSpotter` surface and **has never been executed
  against a real binary in this repo** — its own header says so.
- **Wake quality.** The plan's false-accept ≤ 1/hour and false-reject ≤ 10 % at 3 m
  criteria are **unmeasured**: no test corpus exists, and nothing in this repo
  produces those numbers.
- **Playout on a satellite.** `ethos listen` registers `playback: false` — there is
  no output device behind a pipe. The lane decides *whether the turn speaks* without
  consulting that flag, then gates the **send** on it (`speakAudio = speak &&
  playback`, `SatelliteLane.runTurn`), so nothing is synthesized for this host and no
  TTS latency or spend is paid for bytes that would be discarded on arrival. The
  answer still reaches you as text — the daemon prints `● speech`, `› you:`,
  `‹ <personality>:` and `↩ turn complete` per turn. Hearing it aloud needs a host
  you wire a real `CaptureDevice` and a speaker into.
- **The desktop host.** It cannot listen: the Electron main process ships no
  microphone binding, so `probeSatellite` adds a failing `capture-device` row, the
  host reports `degraded`, and nothing starts. Everything downstream of the device
  is wired and covered by tests through an injected device and socket.

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
- `voice.model` — a fast-lane model for spoken turns. Live on the pipeline tier:
  `buildVoiceStack.createSession` pins it onto the lane's runner, so every turn
  on that lane routes to it (latency decision L5).
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
>   voice to `tts.synthesize`. The language rung is live here too:
>   `detectLanguage()` (`@ethosagent/voice-text`) reads the transcript and is
>   constrained to the tags the personality declares in `voice.languages`, so a
>   Spanish voice note comes back in the Spanish voice. A personality that
>   declares no language map supplies no candidates, no guess is made, and the
>   default voice wins — the behaviour that existed before detection did.
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
> The **`Play` button** on an assistant bubble passes it too:
> `apps/web/src/components/chat/PlayButton.tsx` builds its `voice.synthesize`
> input through `playbackRequest(text, personalityId)`, threaded down from the
> message list. Only the id crosses — the voice, the provider and the egress gate
> are resolved server-side, on the one precedence path above.

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

## 4c. Telephony

A phone number is the one voice surface with a stranger on the other end, and it is
also the one whose end-to-end path **has never been run against a live trunk**. What
follows separates the two halves honestly: almost all of the decision-making is
exercisable with no credentials at all, and only the audio and the real provider
payloads need something you supply.

### What works with zero credentials

The whole inbound path *except the audio* runs against fakes: signature
verification for all four schemes, payload parsing, bot resolution, the four gates,
the receptionist decision, the call-log row transitions, and the owner notification
riding the delivery ledger.

```bash
pnpm vitest run --maxWorkers=4 \
  extensions/call-log \
  extensions/platform-voice/src/__tests__/sip-webhook.test.ts \
  extensions/platform-voice/src/__tests__/inbound-gate.test.ts \
  extensions/platform-voice/src/__tests__/sip-trunk-livekit.test.ts \
  extensions/platform-voice/src/__tests__/livekit-token.test.ts \
  extensions/platform-voice/src/__tests__/g711.test.ts \
  extensions/platform-voice/src/__tests__/frame-pacer.test.ts \
  extensions/platform-voice/src/__tests__/realtime-bridge.test.ts \
  apps/ethos/src/__tests__/sip-webhook-server.test.ts \
  apps/ethos/src/__tests__/sip-inbound-dispatch.test.ts \
  apps/ethos/src/__tests__/livekit-media.test.ts \
  packages/wiring/src/__tests__/far-end-consult.test.ts \
  packages/wiring/src/__tests__/voice-stack.test.ts \
  packages/config/src/__tests__/config-voice-telephony.test.ts \
  apps/web-api/src/__tests__/services/calls.service.test.ts \
  apps/web-api/src/__tests__/services/config-voice-telephony.test.ts \
  packages/web-contracts/src/__tests__/voice-calls.test.ts \
  apps/web/src/features/voice/__tests__/call-row.test.ts \
  apps/web/src/features/voice/__tests__/call-rows.test.ts \
  apps/web/src/features/voice/__tests__/call-row-css.test.ts \
  apps/web/src/pages/__tests__/voice-telephony.test.ts \
  extensions/gateway/src/__tests__/notify-tracked.test.ts
```

```
 Test Files  22 passed (22)
      Tests  335 passed (335)
```

| Suite | Pins |
|---|---|
| `sip-webhook.test.ts` | All four signature schemes, each failing closed with its own distinct reason; Twilio's `bodySHA256` commitment; LiveKit's missing-`exp` treated as expired; Telnyx's raw-vs-PEM Ed25519 key; and the parsers refusing a non-call payload rather than throwing |
| `inbound-gate.test.ts` | Gate order (budget → rate → concurrency → allowlist), a refusal releasing every resource it took, the sliding hour window, the UTC budget rollover, and `prewarm` policy resolution |
| `sip-webhook-server.test.ts` | The listener's status codes — `202` verified, `401` generic-bodied, `200 {ignored}` for a non-call event, `404` for the wrong method or path — and that the handler never blocks on dispatch |
| `sip-inbound-dispatch.test.ts` | The whole ring: unrouted number → `screened` + owner notice, each refusal reason → its status, the receptionist pin, the `ringing`→`live`→`completed` row, and the concurrency slot released on a setup that never reached `live` |
| `extensions/call-log` | `SQLiteCallLog` / `InMemoryCallLog` agreeing, the same-millisecond rowid tie-break, a duplicate id rejected rather than overwriting, and `pruneEnded` never touching a `ringing` or `live` row at any age |
| `far-end-consult.test.ts` | That a call's consult pins `speaker: 'far_end'` and the receptionist personality — the field the spoken-confirmation gate refuses on |
| `livekit-media.test.ts` | The optional-dependency loader: "not installed" and "installed but will not load" as distinct reasons, and a module missing any required export refused at boot rather than mid-call |
| `sip-trunk-livekit.test.ts` · `livekit-token.test.ts` | The Twirp request the SIP control plane receives, the signed JWT's grants, and credentials redacted out of a provider's error body before it can reach a log |
| `g711.test.ts` · `frame-pacer.test.ts` | μ-law/A-law round-trips, and absolute-time pacing that does not drift over a long call |
| `realtime-bridge.test.ts` | The SIP↔provider bridge — built and covered, and with **no production caller** (see below) |
| `config-voice-telephony.test.ts` (×2) | Every `voice.trunk` / `voice.inbound` / `voice.bargeIn` key parsing, refusing, and round-tripping through both the CLI loader and the web config service |
| `calls.service.test.ts` · `voice-calls.test.ts` · `call-row*.test.ts` | The `voice.calls.{list,active,get}` contract, the direction/state filters, and the CallRow's reduced-motion and live-state rendering |

You can also read the whole configured surface without a trunk. `ethos doctor`
prints its telephony rows inside the existing `Voice` section, and the one thing it
actually *runs* is the media resolution:

```bash
ethos doctor
```

With no `voice.*` block at all it prints one line and does not pay for a native
import:

```
  –  Telephony not configured (no voice.*).
```

### What each credential unlocks

| You supply | What becomes real | What stays fake |
|---|---|---|
| `voice.livekit.{url,apiKey,apiSecret}` | The SIP control plane: outbound dialling via `call`, and room access-token minting. Both are plain HTTPS with a signed JWT — no SDK, no native binary | Nothing dials during tests; `ethos doctor` reports the client "constructible — not dialled from here" |
| `voice.trunk.webhookSecret` | The inbound listener starts at all. Without it the gateway prints a warning and leaves it off, because an unsigned webhook is an open line | Real provider payload shapes — the parsers are written against published docs, not captured requests |
| `@livekit/rtc-node` installed on the host | Audio. `resolveLiveKitMedia()` loads it at gateway startup and `voiceStack.createSipAdapter` comes into existence | The adapter's assumptions about the SDK's room/track/frame API. Every one is marked `ASSUMPTION:` in `apps/ethos/src/livekit-media.ts` and none has been executed |
| A realtime provider key | Nothing on the call path today. The bridge tier is not constructible from the gateway — see the gap below | The entire sub-second call tier |

Without the media binding a call is still **verified, gated, screened or answered,
logged, and summarised to the owner**. It simply carries no voice, and both the
startup banner and `ethos doctor` say so in those words.

### The three inert knobs

Named here so nobody tunes them and waits for an effect:

- **`voice.inbound.prewarm`** — the decision is computed on every ring and returned
  in the dispatch outcome, and nothing opens a socket, because
  `createSipRealtimeBridge` has no caller outside its own tests.
- **`voice.trunk.codec`** — parsed, validated and round-tripped through Settings,
  and passed to nothing. Same root cause as `prewarm`: the only thing that
  consumes a wire codec is that same bridge (`deps.codec` in
  `extensions/platform-voice/src/sip/realtime-bridge.ts`), so with no production
  caller the media leg never negotiates from this key. Nothing even maps the
  config's `opus`/`g711` onto the bridge's `pcm`/`g711u`/`g711a`.
- **`voice.bargeIn.satellite.silenceMs`** — parsed, validated, editable in Settings,
  and read by nothing. The satellite `CaptureMachine` ends an utterance on a count
  of silent audio *frames*, and a frame is only a duration once the capture device
  reports its frame size, so there is no honest conversion for the config layer to
  make. The surface's other two fields are wired
  (`readSatelliteVadTuning` in `apps/ethos/src/commands/listen.ts`), as is all of
  `voice.bargeIn.call.*` (`packages/wiring/src/voice-stack.ts`).

  `voice.bargeIn.browser.*` used to sit in this list. It is gone from the union:
  the browser talk lane endpoints in the browser, from `display.voice_*`, and the
  key is now a parse error that names that path.

**`voice.inbound.dailyBudgetUsd` used to sit here too, and no longer does.** The
`meterSpend` wrapper in `apps/ethos/src/sip-inbound-dispatch.ts` reports each
`usage` event's `estimatedCostUsd` as a call's turns stream, and the callback
calls `gates.budget.record(usd)` (line 313) on the same `VoiceInboundGates`
instance `decideInboundCall` consults. The cap genuinely trips.

Know what it counts before you rely on it. The recorded figure is **LLM token
spend only**, at the provider's own estimate. STT, TTS, LiveKit media and PSTN
minutes are not in it — nothing in the process knows those prices, and no rate
was invented for them — and on a voice call they are plausibly the larger half of
the bill. So the cap trips on real spend, but trips **late** relative to a day's
true cost. Under-counting is the safe direction for a gate whose job is refusing
calls; a fabricated per-minute rate would not be.

Two other tiers spend money and never touch this counter: the browser/realtime
voice tier and channel voice notes do not route through this dispatcher, so their
spend does not count against the cap at all.

**Nothing joins the room on an outbound call**, so `call` places the trunk leg
and the callee hears silence. That gap is unchanged.

Outbound calls used to write no call-log row either. They now do —
`extensions/tools-voice/src/index.ts:208` writes `direction: 'outbound'` — and
what such a row does and does not assert is worth knowing before you read one:

- It opens `ringing` before the dial. A trunk rejection patches it to `failed`
  with a real `endedAt`.
- A trunk-accepted dial patches it to `completed` with a reason string and **no
  `endedAt`**. `completed` is an assertion this process never verified — the call
  may have rung out unanswered, and nothing stayed on the line to find out. The
  reason string on the row discloses that inline. With no `endedAt` the row
  leaves `listLive()` and renders no duration, which is what "nobody timed this
  call" looks like.
- The row carries no `personalityId`, no `tier` and no `costUsd`.
- `fromNumber` records as the literal `unknown` when `voice.trunk.fromNumber` is
  unset, because the column is `NOT NULL`.
- Only the **gateway** wires a `CallLog`. A call placed from `ethos serve`,
  `ethos chat` or desktop writes no row at all.

### Manual verification required

Nothing in CI dials a number, and the plan says so explicitly — live-call
verification is manual by design.

- **A real inbound call** on a rented number, end to end: ring → verified → gated →
  answered → `completed` row → summary on the owner's channel.
- **Each provider's real webhook payload.** Twilio form-encoded, Telnyx `call.*`
  events, LiveKit participant attributes — one captured request per provider would
  retire the largest single assumption here.
- **Twilio behind a real TLS terminator.** Its HMAC commits to the public URL, so
  the proxy's `X-Forwarded-Proto` / `X-Forwarded-Host` are load-bearing, and getting
  them wrong is a `401` that looks like a bad secret. Note also that Twilio's scheme
  carries **no timestamp**, so no replay window is enforced for it — the other three
  get one.
- **`@livekit/rtc-node` against a running `livekit-server`.** The first live call is
  what proves or breaks every `ASSUMPTION:` marker in the adapter.
- **A spoken confirmation on a live call** — that a caller's "yes" really cannot
  satisfy an owner-level approval in practice, not only in the ordering test.
- **The concurrency cap under real simultaneous calls**, with frame pacing intact.

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
| LiveKit media | `@livekit/rtc-node` installed on the host (**not a repo dependency**) and `voice.livekit.*`. `livekit-server-sdk` is *not* needed — the SIP control plane is plain HTTPS with a signed JWT. `LiveKitBindings` are no longer app-layer manual either: `resolveLiveKitMedia()` loads the SDK at gateway startup and the gateway passes them through | `ethos doctor` → the `LiveKit media` row, which is the one probe it actually runs | `apps/ethos/src/__tests__/livekit-media.test.ts` for the loader; `extensions/platform-voice/src/__tests__/` against fake room clients. The adapter's SDK assumptions are unexecuted |
| Telephony (inbound SIP) | A SIP trunk, a rented E.164 number, `voice.trunk.webhookSecret`, and a public URL. **No `SipTrunkClient` implementation** — it is derived from `voice.trunk.*` + `voice.livekit.*` by one shared function | Manual only — call the number and read **Communications → Calls** | 22 suites / 335 tests cover verify → gate → dispatch → call log → owner notice against fakes ([§4c](#4c-telephony)) |
| Telephony (outbound `call`) | The same trunk and LiveKit credentials | Manual only. Note the limit: nothing joins the room on the Ethos side, so the callee hears silence. A call-log row *is* written (`direction: 'outbound'`), but only under `ethos gateway`, and it closes as `completed` with no `endedAt` because nothing observed the call ending — see [§4c](#4c-telephony) | `extensions/tools-voice/src/__tests__/call.test.ts`; `call` self-reports unavailable with no trunk, and is in `APPROVAL_SURFACE_ALWAYS_ASK` so it always prompts |
| Channel voice notes | A bot token, and `ffmpeg` on `PATH` for real container conversion | Send a voice note to the bot with `ethos gateway` running (all four declared adapters, in both directions) | `extensions/gateway/src/__tests__/voice-pipeline.test.ts`, `transcode.test.ts`, `voice-caps-sink.test.ts`, `voice-ledger-e2e.test.ts` — every ffmpeg invocation is a fake runner, no binary is ever spawned |
| Wake satellite, open mic (`ethos listen`) | `ethos serve` running and a real PCM pipe (`ffmpeg` / `arecord`) — no `voice.wake.routes` entry required | `make listen-doctor` for the preflight (warn-only runs exit 0), then pipe a mic in and say `<personality>, …` (a `hey` in front is optional) — the row appears under **Settings → Voice → Wake routes**, and the daemon prints `● speech` / `› you:` / `‹ <personality>:` / `↩ turn complete` per addressed turn, and `↩ not addressed to anyone` for everything else | `apps/ethos/src/__tests__/listen-*.test.ts`, `apps/web-api/src/voice/__tests__/satellite-socket.test.ts`, `extensions/voice-satellite/src` — the device and the socket are always injected; no microphone is ever opened |
| Acoustic wake (`voice.wake.engine: sherpa`) | `sherpa-onnx-node` installed by hand (**not a repo dependency**, ~33 MB per-arch native binary) and four model files in `~/.ethos/models/wake/` | Manual only, on a host with a real microphone | Only the *absence* path: `extensions/voice-satellite/src/__tests__/doctor.test.ts` pins that the missing peer and the missing model file are each reported with their own diagnosable message. The spotter mapping itself has **never run against a real binary** |
| Wake quality (false-accept / false-reject) | A recorded ambient corpus and a 3 m test rig | Manual only | **Nothing.** The plan's ≤ 1 false accept/hour and ≤ 10 % false reject at 3 m are unmeasured — no corpus exists in this repo |
| Satellite playout | A player on the satellite's `PATH`. `ethos listen` probes `ffplay`, then `aplay`, then `play`, or takes your own with `--play "<command>"`, and registers `playback: true` when it finds one. Finding none it registers `playback: false`, the lane skips synthesis for that node, and the reply arrives as text. `aplay` and `play` take raw PCM only, so an opus or mp3 reply to either is refused rather than played as noise. The Electron host still has no audio binding | `make listen-doctor` → the `speaker` row names the command it would spawn; then pipe a mic in and listen | `extensions/voice-satellite/src/__tests__/playout.test.ts` (drain receipt, the 90 s watchdog), `apps/ethos/src/__tests__/listen-playback.test.ts` (player resolution, `--play`, `playback_done`). No audio is ever played and no process is spawned |
| Satellite raw-PCM sample rate | Nothing — but know the assumption. `TtsProvider.synthesize` reports no sample rate and the lane never populates the optional wire field, so raw PCM plays at a hardcoded 24 kHz. A reply that sounds fast or slow is that guess; pin it with `--play` and your own `-ar` | Listen to one reply | `playout.test.ts` covers the lane-supplied path, which no production sender reaches |
| Satellite edge STT | A **local** recognizer (`local-stt` or `command-stt`) plus `voice.wake.edgeStt: true`. `ethos listen` resolves it through the same provider path every surface uses and sends only the words upstream | `ethos listen doctor` → the `edge-stt` row constructs the provider and reads its real `caps.local` | `apps/ethos/src/__tests__/listen-edge-stt.test.ts` — edge on sends words and **zero** audio frames; a non-local provider is refused by name, never relabelled |

Manual-verification list, condensed: **`@livekit/rtc-node` against a running
LiveKit server, a live inbound call on a rented number (and one captured webhook
payload per trunk provider), real cloud STT/TTS keys, a real OpenAI Realtime key,
real `command-*` binaries, a real batch STT server consuming the generated WAV, a
real PCM pipe into `ethos listen`, a hand-installed `sherpa-onnx-node` with wake
models, a real player on a satellite, and any wake-quality measurement at all.**
Nothing in CI touches any of these.

---

## 6. Known gaps / not yet built

Do not go hunting for these. They do not exist on this branch.

### 1. Streaming TTS — wired, including the browser
`local-tts` and `openai-tts` implement `synthesizeStream` and declare
`caps.streaming`, and `VoiceSession` uses it: audio is emitted chunk-by-chunk as the
`/v1/audio/speech` response streams, and sentence N+1 is synthesized while N is
still playing (`extensions/voice-session/src/playout-queue.ts`). A provider without
`caps.streaming` still takes the batch path unchanged.

Browser talk-mode uses it too, over the binary WS lane described in §2:
`VoiceService.synthesizeStream` (`apps/web-api/src/services/voice.service.ts:863`)
yields the provider's chunks when `isStreamingTtsProvider` holds and falls back to
one `synthesize` call when it does not, and `createVoiceSocket` wires exactly that
into the lane (`apps/web-api/src/voice/voice-socket.ts:88`). The batch
`voice.synthesize` RPC is still there — it is what the Play button and the
personality-editor Preview call, and what the WS-less fallback path uses.

Still batch-only: `command-tts`, and every STT provider (`openai-stt`, `groq-stt`,
`local-stt`, `command-stt`).

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

### 3. Personality voice — wired on every surface that speaks
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

The **Play button** on an assistant bubble sends `personalityId` too
(`apps/web/src/components/chat/PlayButton.tsx`), so click-to-hear speaks in the
personality's own voice rather than the deployment default. Only the id travels —
the voice, the provider and the local-only egress gate are all resolved
server-side.

The gateway does detect the language of an inbound voice note, but only against
the personality's OWN `voice.languages` keys
(`extensions/gateway/src/index.ts:2069`, tested in
`extensions/gateway/src/__tests__/voice-language.test.ts`): a personality with no
language map produces no guess and its default voice stands, which is the
behaviour that existed before. Detection is on the voice-note path only — a typed
turn is not sniffed for language.

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

### 5. CallStrip and the per-personality voice editor — both shipped
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
`voice.trustedPlugins`, `voice.defaultMode`, the per-channel
`voice.channels.<platform>.ttsOut` switches, the advanced `voice.transcode.*` and
`voice.artifacts.*` fields, and the `auxiliary.*` timeouts and
output format. It also carries a read-only delivery-status readout over the
`deliveries.summary` RPC — pending / redelivering / delivered / abandoned counts,
with the same counts restricted to `kind = 'voice'`. One edge stays config-file only: an allowlist that is **declared
but empty** (`voice.trustedPlugins:` with no value) arms the gate with nothing
trusted. Settings treats an empty list as "gate off" because the web config
writer cannot round-trip an empty value; write that line by hand if you want it.

A personality's own `voice.*` block is edited in the Personalities tab
(`apps/web/src/components/personality/PersonalityVoiceFields.tsx`). All eight
sub-keys are there — `tts_provider`, `tts_voice`, `stt_provider`,
`realtime_provider`, `call_style`, `tier`, `model`, and the
`languages.<tag>` map as a dense row editor. The block stays FROZEN as a schema:
these are sub-keys of the existing `voice` object, so `.personality-field-count`
is untouched at 28. The character sheet still renders the block read-only.

`voice.tier` now has a consumer: `VoiceService.mintRealtimeToken`
(`apps/web-api/src/services/voice.service.ts`) runs it through
`resolveVoicePreferences` against the deployment's `voice.tier`, and an explicit
`pipeline` refuses the mint with `pipeline_preferred`. Absent from both means
"try realtime". The global default is editable in Settings → Voice.

`voice.model` — the fast-lane model for spoken turns — now has a consumer on the
**pipeline tier**. `buildVoiceStack.createSession` (`packages/wiring/src/voice-stack.ts`)
resolves it through `resolveVoicePreferences` and wraps the supplied runner, so
every turn on that lane carries `RunOptions.modelOverride` without each host
having to remember it. `AgentLoop` consumes the field in its turn-setup stage and
it lands on `CompletionOptions.modelOverride`; `run_start` and the `llm_call`
span name the pinned model, so telemetry cannot claim the default answered.

The routing ladder, pinned by `packages/core/src/__tests__/model-tier.test.ts`
(`model routing precedence`) on what the LLM provider was actually asked for:

```
RunOptions.modelOverride  >  tierOverride  >  personality model  >  deployment default
```

No deployment-level fast-lane default is passed as `globalModel`: `config.voice.*`
has no such key, and `config.model` is the agentic default — the one model L5
exists to keep off the spoken lane. The fast-lane model resolves from the
personality alone.

Two gaps remain. The **realtime tier** does not use it: a realtime call's model
comes from the roster entry (`selection.entry.model` in `mintRealtimeToken`), not
from the personality's `voice.model`. And a personality whose toolset carries
`think_deeper` can still escalate off the pinned model mid-turn — the escalation
in `agent-loop/stages/stream-step.ts` outranks the pin. The built-in `voice`
personality carries no such tool, so nothing shipped hits it.

```bash
pnpm vitest run \
  packages/core/src/__tests__/model-tier.test.ts \
  packages/wiring/src/__tests__/voice-stack.test.ts
```

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

Telephony used to be listed here as "beyond the typed seams". It shipped — the
inbound webhook listener on the gateway command, the four signature schemes, the
hardening gates, the receptionist scope, the SQLite call log, the owner summary
through the delivery ledger, `voice.calls.*` and the Communications → Calls tab, and
an optional-dependency loader that gives a call audio once an operator installs
`@livekit/rtc-node`. See [§4c](#4c-telephony). Four things inside it did **not**
ship:

- **The SIP↔realtime bridge tier.** `createSipRealtimeBridge` is built and tested
  and has no caller outside its own suite, because `VoiceStack` exposes no
  `RealtimeVoiceProvider` or `VoiceTransport` for the gateway to construct one
  from. `voice.inbound.prewarm` therefore decides something nothing acts on.
- **Voicemail / answering-machine detection.** Explicitly deferred by the plan,
  recorded as a decision rather than an omission.
- **Outbound as a conversation.** `call` dials through the trunk under an approval,
  and nothing joins the room on the Ethos side, so the callee hears silence. No
  call-log row is written for an outbound call either.
- **Any live-call verification.** Every payload parser and every signature scheme is
  written against published documentation. No captured request from any provider
  has ever been replayed through them.

The wake-word satellite used to be listed here in full. It shipped — the shared
`extensions/voice-satellite` package, the `/satellite/ws` lane on **web-api**,
`ethos listen` / `ethos listen doctor`, the desktop main-process host, and the
Settings → Voice wake-route manager. `shouldReplyWithVoice`'s `wakeTriggered` flag
now has a caller: `SatelliteLane.runTurn`. Four things inside it did **not** ship,
and they are the reasons not to plan an ambient deployment around it yet:

- **Acoustic wake on any host.** `ethos listen` runs an open mic gated on the
  server's transcript, not on sound; the sherpa adapter
  has never run against a real binary, and `sherpa-onnx-node` is not installed.
- **A microphone on the desktop host.** It reports `degraded` with "no capture
  device configured" and declines to start.
- **Wake-quality numbers.** No corpus, no measurement.
Edge STT used to be listed here too. It shipped on `ethos listen`:
`voice.wake.edgeStt: true` plus a **local** recognizer makes the daemon transcribe
on the satellite and send only the words upstream — no `audio` frames at all — and a
non-local recognizer is refused by name rather than relabelled, because declaring
"at the edge" for a cloud transcriber would make the guarantee false in exactly the
deployment that asked for it. The Electron host still ships no recognizer and no
capture device. Satellite **playout** also shipped; see [§5](#5-what-needs-credentials-or-hardware-you-supply).

Channel TTS-out and the ffmpeg transcode stage used to be listed here. Both
shipped — see [§ Channels](#channels) for the declared-caps model that carries
TTS-out to all four adapters, and `extensions/gateway/src/transcode.ts` for the
stage. ffmpeg itself remains an optional host binary: without it the gateway
sends only formats the TTS provider already produces.

The realtime tier itself shipped ([§4b](#4b-the-realtime-tier)). One thing inside
it did not: a **server-relay path**, so `gemini-live` is contract-only and cannot
serve a browser call. The **fast-lane model** used to be listed here too — it
shipped for pipeline turns, and a realtime call still routes from the roster
entry rather than `voice.model`.

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
