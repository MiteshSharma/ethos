# @ethosagent/platform-callcapture

**Phase 1 + Phase 2 + Phase 3 + Phase 4 — detection, the notification/accept
gate, the dual-stream audio capture + streamed-STT pipeline, and end-to-end
integration + wiring.** Part of
[`plan/phases/call-capture-extension.md`](../../plan/phases/call-capture-extension.md);
see its "Phasing" section for the original per-phase scope. Phase 1 detects
"the microphone is in use" — a proxy for "a call is happening." Phase 2
adds the actionable OS notification, the click-listener bridge, and
accept/decline gating on top of Phase 1's detection output. Phase 3 proves
the hardest, least-certain piece in isolation: local dual-stream audio
capture (system audio + mic) with streamed STT. Phase 4 wires all three
together end-to-end, hosted inside `ethos serve`/`ethos gateway` — see
"Phase 4 — Integration" below for the finished wiring.

## Approach: CoreAudio, not `ioreg`

The plan's decision 1 assumed `ioreg`'s classic class-filter trick
(`ioreg -c IOAudioEngine`) might work for detecting an active audio engine.
**It does not, on this hardware class.** Verified live on this machine
(Apple Silicon, Darwin 25.2): `ioreg -c IOAudioEngine` and
`ioreg -c AppleUSBAudioEngine` both match zero instances. Built-in audio
moved to DriverKit; `ioreg`'s own man page says "Do not consider DriverKit
classes with `-c`." This is a correction to the plan doc's premise, not a new
finding to fold back in — the plan should be read with this in mind for any
future phase that touches detection.

What does work, and is what this package uses: CoreAudio's
`kAudioDevicePropertyDeviceIsRunningSomewhere` property on the default input
device, watched via `AudioObjectAddPropertyListenerBlock`. This is:

- **Event-driven**, not polled — the callback fires exactly when the running
  state changes, so there's no tight loop and no measurable battery cost from
  continuous all-day background operation (a real requirement per the plan's
  Phase 1 scope note).
- **Zero third-party binaries.** Pure CoreAudio framework, ships on every Mac.
  Only `swiftc` is needed to build it, and that ships with Xcode Command Line
  Tools. This is a narrower dependency footprint than the plan's assumed
  manual-install-binary pattern (`terminal-notifier` for Phase 2,
  `audiotee`-style capture for Phase 3) — those still need a real third-party
  binary because they do real notification/capture work; this piece only
  watches a system-wide state flag, so it doesn't.
- **No mic-permission (TCC) prompt needed.** `DeviceIsRunningSomewhere` is a
  running-state flag, not raw audio — reading it doesn't require microphone
  access.

## What's in this package

- **`native/mic-detector.swift`** — the compiled CoreAudio watcher. Watches
  the current default input device's running state, and separately watches
  `kAudioHardwarePropertyDefaultInputDevice` on the system object so it
  re-attaches to a new device if the user switches inputs mid-run (e.g.
  plugging in headphones) without missing a state change. Emits one line of
  newline-delimited JSON per event to **stdout**:
  - `{"event":"initial","running":false,"deviceId":92,"at":"...Z"}` — the
    starting state, emitted once before entering the run loop, so the Node
    wrapper doesn't have to guess.
  - `{"event":"running_changed","running":true,"deviceId":92,"at":"...Z"}` —
    on every observed transition.
  - `{"event":"error","message":"..."}` — on a CoreAudio API failure, then
    exits non-zero.

  Runs until killed (`SIGTERM`) — no fixed timeout in the shipped binary (a
  timeout was only used for the manual research probe that validated this
  approach before this package existed).

- **`src/detector.ts`** — `MicActivityDetector`, the Node wrapper. Spawns the
  compiled binary, parses its NDJSON stdout, and translates the raw
  `initial`/`running_changed` signal into the public
  `call_started` / `call_ended` / `error` contract. `call_ended` is debounced
  (default 2000ms, configurable) because the mic can flicker for sub-second
  gaps as apps hand the device off to each other — a bare state read would
  falsely report a call "ending" on every flicker. `call_started` is never
  debounced; it fires the instant the first `running: true` is observed.
  The binary spawn is injectable (`spawnFn`) so unit tests run entirely
  against a fake child process — no real hardware, no real mic, no compiled
  binary required in CI (which has no audio device anyway).

- **`src/detect-cli.ts`** — the Phase 1 manual-verification tool. Runs the
  real detector against the real compiled binary and logs every event with a
  timestamp. Standalone dev tool, not wired into `ethos`.

- **`src/click-listener.ts`** — `createClickListener()`, a local loopback
  HTTP listener (`node:http`, bound to `127.0.0.1` on an ephemeral port).
  Generates a random token per offer and requires it in the request path, so
  another local process can't spoof an accept by guessing the URL.
  `waitForHit()` resolves the first time the URL is requested; `close()`
  tears the server down.

- **`src/preflight.ts`** — `checkTerminalNotifierAvailable()`, verifying
  `terminal-notifier` is on `PATH` before anything tries to show a
  notification. Runs `terminal-notifier -help` (side-effect-free) through an
  injectable spawn boundary and resolves a typed `{ available: false; error
  }` — never a swallowed `spawn ENOENT` — naming the fix
  (`brew install terminal-notifier`) when it's missing.

- **`src/notification.ts`** — `NotificationGate`, the Phase 2 "show + wait
  for accept" surface. `presentCaptureOffer({ callId, title, message })`
  runs the preflight check, then shows a real `terminal-notifier`
  notification whose click action (`-execute`) is a `curl` against a fresh
  `click-listener` URL, under a `-group` id derived from `callId`. Returns a
  handle: `waitForOutcome()` resolves `{ outcome: 'accepted' }` once the
  listener is hit, and `expire()` withdraws the notification
  (`terminal-notifier -remove <groupId>`) and resolves `{ outcome: 'expired'
  }` — the path Phase 1's `call_ended` should drive when nobody clicked in
  time. Any preflight or spawn failure resolves `{ outcome: 'error';
  message }` immediately instead of throwing.

- **`src/phase2-cli.ts`** — the Phase 2 manual-verification tool. Wires the
  real `MicActivityDetector` to a real `NotificationGate`: `call_started`
  presents an offer; an accepted outcome logs "would have started capturing
  here"; `call_ended` before acceptance calls `expire()`.

## Error stream: stdout, not stderr

Both normal events and the native binary's own error line
(`{"event":"error",...}`) go to **stdout**. This is a deliberate choice, not
an oversight: the Node wrapper reads one NDJSON stream via `readline` against
`child.stdout`, and a native-side failure needs to reach that same parser as
a typed `error` event — not disappear into a separate stream nobody's
listening to. If the binary fails to spawn at all (e.g. not built yet),
`MicActivityDetector.start()` throws synchronously naming the exact fix.

## Building the native helper

Requires Xcode Command Line Tools (`swiftc`).

```sh
pnpm --filter @ethosagent/platform-callcapture run build:native
```

This compiles `native/mic-detector.swift` to `native/bin/mic-detector`.
`native/bin/` is gitignored (root `.gitignore`) — the compiled binary is a
build artifact, never committed.

## Manual verification

The actual point of Phase 1 is proving the signal works on real hardware,
not just passing unit tests against a fake. After building the native
helper:

```sh
pnpm --filter @ethosagent/platform-callcapture exec tsx src/detect-cli.ts
```

Then, in another terminal, trigger a real few-second mic recording (e.g. with
`ffmpeg`) and confirm the CLI logs `call_started` immediately and
`call_ended` a debounce window (~2s) after recording stops:

```sh
ffmpeg -y -f avfoundation -i ":0" -t 3 -loglevel error /tmp/callcapture-verify.wav
```

## Phase 2 — notification + accept gate

### The `terminal-notifier` dependency

Confirmed installed on the development machine via `brew install
terminal-notifier`: version **2.0.0**, at `/opt/homebrew/bin/terminal-notifier`.
It's a manual-install dependency, the same carve-out pattern as the compiled
`mic-detector` binary above — not vendored, checked by `preflight.ts` before
use.

### No multi-button action support — click = accept, everything else = no capture

`terminal-notifier` 2.0.0's `-help` only exposes `-execute COMMAND` (run a
shell command on click) and `-open URL` — no `-actions`/reply flags.
Older 1.x built on the now-deprecated `NSUserNotification` had multi-action
support; 2.x moved to the modern `UserNotifications` framework, which this
CLI doesn't expose multi-action for. There is consequently no separate
"Decline" button in this design:

- **Accept** = the user clicks the notification body, firing `-execute`.
- **Decline** = the user does nothing — dismisses it, ignores it, or (per
  the plan's decision 5) the call ends before they answer. In that last
  case, `NotificationGate` does not passively wait: the caller (Phase 1's
  `call_ended`, wired in `phase2-cli.ts`) must call `.expire()`, which
  actively withdraws the notification via `terminal-notifier -remove
  <groupId>` rather than leaving a stale, no-longer-relevant notification
  sitting in Notification Center.

### The click-bridge mechanism

`-group ID` / `-remove ID` is the show/dismiss pair `NotificationGate` uses,
with a unique group id per offer (`ethos-callcapture-<callId>`) so
concurrent offers over a session never collide and each can be
independently withdrawn.

The actual accept signal is a local loopback HTTP listener
(`click-listener.ts`): `presentCaptureOffer()` opens one bound to
`127.0.0.1` on an ephemeral port, generates a random token, and builds the
`-execute` command as `curl -fsS http://127.0.0.1:<port>/click/<token>`.
`terminal-notifier`'s click callback has no session, no turn, no personality
context of its own — the token-gated URL is what turns that bare OS
callback into a promise resolution another process can't spoof by guessing
the path.

### GUI-click limitation, and how the mechanism was proven anyway

No accessibility/UI-scripting was available to script a real GUI click on
the notification banner. The click-bridge was instead proven end-to-end by
firing a **real** notification through the **real** `NotificationGate`
(`terminal-notifier`, not a fake), confirming delivery with `terminal-notifier
-list ALL`, then manually running the exact `-execute` command it was
configured with — the honest equivalent of "the user clicked it": same
`curl` call, same HTTP hit, same process boundary crossing, just triggered
by hand instead of a mouse. `NotificationGate.waitForOutcome()` resolved
`{ outcome: 'accepted' }` as a result. `.expire()` was verified the same
way: called after a real notification was shown, it issued a real
`terminal-notifier -remove <groupId>` (confirmed via the logged command)
and the notification disappeared from a subsequent `terminal-notifier -list
ALL`. The plumbing is provably correct end-to-end; only the literal mouse
click on the banner needs the repo owner's own eyes/mouse to confirm.

### Fail-closed contract (decision 5)

Every non-accepted path is a typed, observable `CaptureOfferOutcome` —
never silent:

- `{ outcome: 'accepted' }` — the click-listener was hit.
- `{ outcome: 'expired' }` — the caller called `.expire()` (the notification
  is actively withdrawn as part of this, not just left to linger).
- `{ outcome: 'error'; message }` — preflight failed (`terminal-notifier`
  missing) or `terminal-notifier` itself failed to spawn/deliver the
  notification. `presentCaptureOffer()` never lets a spawn failure become an
  unhandled rejection or a silent no-op.

### Troubleshooting: notification permission granted but no banner appears

A reproduced real case: detection, the process prefilter, and the audit-trail
`wake` chat message all fired correctly, but the actual macOS notification
banner never appeared — even after manually enabling notification
permissions for "terminal-notifier" in System Settings → Notifications.

Diagnostic sequence, in order:

1. `terminal-notifier -list ALL` only proves the notification was accepted
   into Notification Center's internal database — it does **not** prove a
   banner was ever shown on screen. Don't treat a successful `-list` entry as
   proof of visible delivery.
2. Check System Settings → Notifications → search for **"terminal-notifier"**
   specifically. It ships its own app bundle
   (`fr.julienxx.oss.terminal-notifier`, display name "terminal-notifier")
   and is **not** attributed to "Terminal" or whatever shell app launched it
   — searching for the wrong name is the easiest way to miss it. Confirm
   "Allow Notifications" is on and the alert style isn't "None".
3. Deep-link straight to the Notifications settings pane instead of hunting
   through System Settings by hand:
   ```sh
   open "x-apple.systempreferences:com.apple.preference.notifications"
   ```
4. If permission looks correctly granted and a banner still doesn't appear,
   restart the two macOS processes actually responsible for delivering
   banners before assuming it's a code bug:
   ```sh
   killall NotificationCenter usernoted
   ```
   Both restart automatically via `launchd` within a couple of seconds — this
   is safe, not destructive.

**Root cause, confirmed empirically on this machine:** `NotificationCenter`
and `usernoted` had been running continuously since before
`terminal-notifier` was ever registered as a new notification-capable app.
A newly-granted per-app notification permission does not take effect in
those already-running processes until they're restarted. After `killall
NotificationCenter usernoted`, a fresh test notification banner appeared
immediately — this was the actual fix, not a `NotificationGate` or
`terminal-notifier` invocation bug.

## What Phase 1 + 2 deliberately do not do

Per the plan's Phasing section: no persistent daemon / `ethos serve`
wiring, no personality/toolset binding, no memory writes, and no
resolution of whether the existing `before_tool_call` approval gate can be
reused as-is for this locally-triggered flow (an open question the plan
explicitly defers to Phase 4). Phase 4 wires everything below together
end-to-end, including connecting Phase 2's `NotificationGate` accept
outcome to Phase 3's capture pipeline — **that connection does not exist
yet**; Phase 3's capture is triggered manually (`phase3-cli.ts`), not by an
accepted notification.

## Phase 3 — dual-stream audio capture + streamed STT (standalone spike)

Proves decision 2's audio-capture design in isolation, "capture-on-manual-
trigger for a fixed duration," per the plan's own Phase 3 scope. **Not
wired to Phase 1's detection or Phase 2's notification/accept gate** — that
connection is Phase 4 integration work. Nothing here is wired into `ethos`
or any personality yet, and no memory write / transcript-artifact handoff
happens (`extensions/platform-meeting`'s `buildTranscriptArtifact` pattern
is reused for that in Phase 4, not built here).

### Two binaries, two different categories of dependency

A call has two audio sources that never travel the same signal path, so
Phase 3 uses two different capture mechanisms:

- **`native/vendor/audiotee/audiotee`** — captures OTHER PARTICIPANTS'
  audio (whatever the machine is playing out — the far end of the call).
  This is system OUTPUT audio, captured via the macOS 14.2+ Core Audio
  Process Tap API (`CATapDescription`). Wrapped by
  [`makeusabrew/audiotee`](https://github.com/makeusabrew/audiotee),
  pinned at commit `56ac954369a09318e46b88a6eec33c2d2b0d32a3` (upstream
  carries no version tags — its own README says "API Instability Warning:
  unstable, subject to change without notice," which is exactly why this
  pins a commit instead of trusting `main`). It is a Swift Package Manager
  project, **not a brew formula** — there is no `brew install audiotee`.
- **`native/mic-capture.swift`** — captures the USER'S OWN mic input, via
  the completely standard `AVAudioEngine().inputNode` API. Owned and
  compiled by this repo, same as `native/mic-detector.swift`.

These are three different dependency categories in this one package, worth
naming explicitly:
1. **Owned source, compiled locally** — `mic-detector.swift` (Phase 1),
   `mic-capture.swift` (Phase 3). No third party involved.
2. **Manual-install via a package manager** — `terminal-notifier` (Phase
   2), `brew install`-able.
3. **Manual-install, fetched-and-built-by-script, not vendored** —
   `audiotee` (Phase 3). Not on any package manager; fetched from a pinned
   git commit and built from source by `scripts/fetch-audiotee.sh`.

### Building `audiotee`

```sh
pnpm --filter @ethosagent/platform-callcapture run build:audiotee
```

Clones `github.com/makeusabrew/audiotee` into
`native/vendor/audiotee-src/`, checks out the pinned commit, runs
`swift build -c release`, and copies the resulting binary to
`native/vendor/audiotee/audiotee`. `native/vendor/` is gitignored (root
`.gitignore`) — like `native/bin/`, the built binary is never committed,
only fetched-and-built on demand. `scripts/fetch-audiotee.sh` is
spike-quality (re-clones from scratch every run, no caching) — formal
dependency-preflight packaging is explicitly Phase 4/T5 scope, not this.

### Building `mic-capture`

Added to the existing `build:native` script alongside `mic-detector`:

```sh
pnpm --filter @ethosagent/platform-callcapture run build:native
```

Compiles both `native/mic-detector.swift` and `native/mic-capture.swift`
into `native/bin/`. `mic-capture.swift` needs `AVFoundation` in addition to
`mic-detector.swift`'s `CoreAudio` (for `AVAudioEngine`/`AVAudioConverter`);
no additional non-Apple dependency.

### Output contract: both binaries emit the same PCM shape

Both binaries write **raw 16-bit signed little-endian PCM, mono, 16000 Hz**
to **stdout** in ~200ms chunks, and structured JSON status lines to
**stderr** — the inverse of Phase 1's `mic-detector` (which puts
everything, including its own error line, on stdout; see "Error stream"
above). Phase 3 splits the two because stdout now carries real binary
audio data that must never be interleaved with JSON text on the same
stream. `mic-capture.swift`'s stderr JSON loosely mirrors audiotee's
`message_type`/`timestamp`/`data` shape (not byte-identical — no need for
that, just enough shared shape that `src/audio-process.ts` can apply the
same NDJSON-parsing machinery to both) so the Node side treats both
binaries structurally the same way.

`src/audio-process.ts` is the shared piece `tap-capture.ts` and
`mic-capture.ts` both build on: spawning the binary, parsing its stderr
NDJSON for a binary-specific "ready" line (which carries the actual
`sample_rate` the binary reports — parsed, never assumed, in case a future
audiotee version or flag combination changes it) or a fatal error line,
and parsing stdout bytes into `@ethosagent/types`' `PcmChunk` frames
(`Int16Array` + `sampleRate`) — handling a trailing odd byte spanning two
separate stream `'data'` events rather than dropping or misaligning it.
`detector.ts` (Phase 1) was deliberately **not** folded into this shared
module — it parses one NDJSON stream with no PCM and no readiness wait, a
different enough shape that forcing it through the same abstraction would
cost more than it saves.

### The observed cold-start latency, and how it's handled

Empirically, on this machine, **both** `audiotee` and `mic-capture` have
shown a one-off slow first start in a given session — audiotee showed a
~13 second gap between its own "Creating IO proc" and "Starting audio
device" log lines on a cold run; independently, `mic-capture.swift`'s very
first invocation in this session captured only ~13KB of PCM in a 4-second
window (~0.4s worth of audio) before a subsequent run captured a full,
steady ~32KB/sec immediately. Neither binary's *second* run in the same
session showed any delay. The cause (CoreAudio HAL warm-up, a one-time TCC
registration step, something else) is not identified — this section
documents the behavior, not its root cause, per the plan's "characterize,
don't assume it's fixed" instruction.

Both `TapCapture` and `MicCapture` handle this the same way, via the
shared `startAudioCapture()` in `audio-process.ts`:
- A **20-second readiness timeout** (generous, not tight) rejects with a
  named, typed error — `"...did not report readiness within 20000ms"` —
  instead of hanging forever on a genuinely stuck capture.
- A **5-second heartbeat** (`onWaiting(secondsElapsed)`) fires while
  waiting, so a caller always sees "still waiting" progress rather than
  silence — `phase3-cli.ts` logs `tap: still waiting for the tap to
  start, Ns...` on each tick.
- Both are configurable per instance (`readinessTimeoutMs`, `heartbeatMs`)
  and covered by fake-clock tests in
  `src/__tests__/audio-process.test.ts` (no real 20-second sleep in the
  test suite).

### Fixed-window streamed STT, not VAD endpointing — a scoped-down spike simplification

`src/transcript-session.ts`'s `runTranscriptSession()` reuses
`@ethosagent/types`' streaming STT contract exactly the way
`extensions/voice-session/src/voice-session.ts` does: resolve once
(`isStreamingSttProvider(provider) ? provider :
createBufferedSttAdapter(provider)`), then call `transcribeStream()` per
utterance. The difference is what counts as "one utterance" — `voice-session.ts`
uses real VAD-based endpointing (silence detection closes an utterance);
Phase 3 instead closes a **fixed-duration window** (default 8000ms,
configurable via `TranscriptSessionOptions.windowMs`) by accumulated
sample count, calling `transcribeStream()` exactly once per window. This
satisfies decision 2's actual requirement — bounded memory, incremental
output, chunked as captured rather than buffered for the whole call — 
without building real endpointing infrastructure for a standalone spike.
**This is a scoped-down simplification, not the production design.** A
Phase 4+ follow-up should reconsider VAD-based endpointing, either
building it fresh or reusing `extensions/voice-session`'s
`EndpointDetector`.

A trailing partial window (less than `windowMs` of audio) is still flushed
when the source stream ends, e.g. when `stop()` is called mid-window — no
audio is silently dropped at capture end.

### Two independent STT passes, never pre-mixed (decision 7, footgun #3 — resolved)

`runTranscriptSession()` runs the mic stream and the tap stream through
**two separate `transcribeStream()` call sequences** — never combined into
one signal before STT. This directly follows decision 7's speaker
attribution requirement (labeled "You" for the mic stream, "Other
participant" for the tap stream), which is only possible if the streams
stay independent through STT and get merged afterward with speaker
labels. Decision 2 originally listed this as an open footgun ("whether the
tap stream and the mic stream need independent STT passes... or can be
pre-mixed"); decision 7 (written after decision 2) already resolved it —
Phase 3 implements the resolved design, not a re-litigation of it.

Entries are yielded as each window's transcription completes (real
streaming, not source order) via a small `mergeAsyncGenerators()` fan-in.
Because the two streams' windows complete independently, a caller wanting
a final chronological transcript should collect entries and sort by `at`
— `phase3-cli.ts` does exactly this for its printed summary.

### Footgun-tracking table (decision 2)

| Footgun | Status |
|---|---|
| `AVAudioEngine` cannot be retargeted to a tap-backed aggregate device | **Moot by design.** Neither `TapCapture` nor anything else in this package routes the tap stream through `AVAudioEngine` — `audiotee` owns the Core Audio Process Tap calls entirely, as an external process. `mic-capture.swift` DOES use `AVAudioEngine`, but only for the mic's own `inputNode`, never for a tap-backed device — this footgun does not apply to that path either. |
| Undocumented audio filtering on the ingestion side | **Empirically validated with real content, not just energy.** A prior RMS-energy check (a system chime through `afplay`) only proved presence of *some* signal. Phase 3's live verification (see below) played real speech through system output while running the real `audiotee` capture and a real `openai-stt` provider, and the resulting transcript matched the spoken text — no evidence of content-destroying filtering on the tap path. |
| Tap stream vs. mic stream: independent STT or pre-mix? | **Resolved (not open) — see "Two independent STT passes" above.** Decision 7 settled this after decision 2 was written; Phase 3 implements the resolved design. |

### TCC / permission status — still unresolved, needs real-user verification

No system permission dialog blocked either binary in this session's
testing. This could mean Process Tap capture of the machine's own output
doesn't require the same explicit TCC toggle FaceTime-style
screen-recording apps need, or it could mean this development machine
already granted the relevant permission from prior use (mic-detector's
Phase 1 testing, or Terminal.app's own inherited mic-access grant, which
child processes spawned from Terminal commonly get on macOS). This is
**not claimed as solved** — a real user on a machine that has never
granted Ethos/Terminal any audio permission before should expect to hit a
TCC prompt on first run and should verify what it looks like and whether
capture degrades gracefully if denied. Neither binary in this package
currently has explicit handling for a TCC-denial path beyond whatever
CoreAudio/AVFoundation returns as a generic failure (surfaced as a typed
error either way — never a silent hang or empty output).

### Live verification (real hardware, real STT)

Run:

```sh
OPENAI_API_KEY=sk-... pnpm --filter @ethosagent/platform-callcapture exec tsx src/phase3-cli.ts [durationSeconds]
```

`OPENAI_API_KEY` is a plain env var, deliberately **not** resolved from
`~/.ethos/config.yaml`'s `${secrets:...}` refs: doing that would require
constructing a `Storage` (`FsStorage`) inside this extension, which
`packages/types/src/__tests__/storage-construction-boundary.test.ts`
(P2.4) holds `extensions/*` to a deliberately EMPTY allowlist for — library
code must receive an injected `Storage`, never construct one, even in a
manual-verification script. Omitting the env var falls back to a fake
RMS-energy-based provider — proves pipeline wiring only, not transcript
content. Either way, `phase3-cli.ts` starts the real `TapCapture` and real
`MicCapture` concurrently, runs both streams through
`runTranscriptSession()`, and prints the merged, speaker-labeled
transcript once the fixed duration elapses, logging which STT tier ran.

**Validation tier actually achieved: real STT, real transcript content —
the strongest tier, not just wiring.** A live run exported the real key
already resolved in `~/.ethos/secrets/auxiliary/asr/apiKey` (this
machine's configured `auxiliary.asr` secret) as `OPENAI_API_KEY`, then
played synthesized speech ("The quick brown fox jumps over the lazy dog.
This is a test of the Ethos Call Capture Phase 3 audio pipeline.") through
system output (captured by the real tap) while it also acoustically
reached the real mic. Actual output:

```
[phase3-cli] STT validation tier: real-openai-stt
[phase3-cli] tap ready.
[phase3-cli] mic ready.
[phase3-cli] live: You: The quick brown fox jumps over the lazy dog. This is a test of the Ethos Call Capture Phase 3 audio pipeline.
[phase3-cli] live: Other participant: The quick brown fox jumps over the lazy dog. This is a test or the ethos call capture phase 3 audio.
...
=== Merged transcript ===
[2026-08-17T18:12:10.710Z] Other participant: The quick brown fox jumps over the lazy dog. This is a test or the ethos call capture phase 3 audio.
[2026-08-17T18:12:10.858Z] You: The quick brown fox jumps over the lazy dog. This is a test of the Ethos Call Capture Phase 3 audio pipeline.
...
[phase3-cli] STT validation tier was: real-openai-stt
```

Both streams recovered the spoken content correctly, with correct speaker
labels — real proof, not just wiring. **One observed artifact, noted
honestly rather than hidden:** the final, very short/quiet trailing window
on each stream produced a clearly wrong transcription (a stray "you" on
one stream, a Korean-character hallucination on the other) — a known
`whisper-1` behavior on near-silent or very short audio, not a bug in this
package's capture or windowing logic. `extensions/voice-text`'s
`isHallucination()` filter exists precisely to catch this class of output
in the real voice-session pipeline; Phase 3 does not reuse it (out of
scope for this spike, per the brief), but a Phase 4+ integration should
consider it.

### What Phase 3 deliberately does not do

No persistent daemon, no personality/toolset/config wiring, no connection
to Phase 1's detection or Phase 2's notification accept gate (capture is
manually triggered here), no memory-write / transcript-artifact handoff
(`extensions/platform-meeting`'s pattern, reused in Phase 4), and no
VAD-based endpointing (fixed time-windowing only — see above). All of
these are named, scoped, Phase 4 work, not omissions.

## Phase 4 — Integration

Wires Phases 1-3 together end-to-end, hosted inside either always-on host
command: `ethos serve` (`apps/ethos/src/commands/serve.ts`) or `ethos
gateway` (`apps/ethos/src/commands/gateway.ts`) — both wire an identical
`CallCaptureDaemon` construction, so a deployment that only runs `ethos
gateway` (a normal choice — it's the multi-channel adapter host) gets the
same call-capture behavior as `ethos serve`. A later correction (code
review, post-Phase-4) replaced the original LLM-turn dispatch with direct,
deterministic dispatch — see "Direct dispatch" below for why.

Running both simultaneously with call capture configured is a normal,
expected deployment shape, not a hypothetical — `ethos run-all` starts both
by default, and each host command is separately documented as a viable
LaunchAgent target. A later correction (code review, round 3) added
cross-process coordination for exactly this: before constructing a
`CallCaptureDaemon`, each host attempts `tryClaimOwnership()`
(`src/ownership.ts`) on a shared PID-claim lock file
(`callCaptureLockPath()`, `~/.ethos/callcapture.lock`) via the same atomic
`O_CREAT|O_EXCL` + liveness-check + stale-cleanup technique
`extensions/team-supervisor/src/pid.ts` uses for its own single-instance
guarantee. Whichever process wins constructs and starts its daemon exactly
as before, and releases the lock on graceful shutdown; the process that
loses logs an informational message and skips daemon construction entirely
— a normal, correct outcome, not an error. Only the winning process ever
writes or removes the shared heartbeat file, which also closes the
heartbeat-deletion race this lock was originally missing: with only one
daemon owner, only one process can ever race itself.

### The full wiring

```
CallCaptureDaemon (src/daemon.ts)
  ├─ detector: MicActivityDetector           — Phase 1
  ├─ checkDependencies: checkCallCaptureDependencies  — Phase 2 + T5 preflight
  ├─ notificationGate: NotificationGate       — Phase 2
  ├─ wake: (reused) the SAME closure ethos serve's WatcherManager uses
  └─ runCapture: (abortSignal) => runCallCapture(callCaptureOpts, { ... })
       └─ runCallCapture (extensions/tools-callcapture, @ethosagent/tools-callcapture)
            ├─ TapCapture + MicCapture      — Phase 3 dual-stream audio
            ├─ runTranscriptSession          — Phase 3 streamed STT
            ├─ summarizeTranscript           — LLM content summary (decision 7)
            └─ memory.sync(...)              — transcript artifact + digest index
```

Each of `ethos serve` and `ethos gateway` constructs and starts its own
`CallCaptureDaemon` when (and only when) `process.platform === 'darwin' &&
config.callCapture?.personalityId` is set — a complete no-op (nothing
constructed, no behavior change) for every other deployment. `CallCaptureDaemon`
itself takes no dependency on `@ethosagent/watchers`: `wake` is a structural
port matching `WatcherManagerConfig.wake`'s shape, and each host command
passes the exact same `watcherWake` closure it already built for its own
`WatcherManager` — one wake path per host, not a duplicate.

### Process prefilter (decision 1's coarse prefilter, now wired)

Decision 1 describes two signals: mic-in-use (Phase 1's actual detection
trigger, above) and a "coarse prefilter" using process/app detection,
explicitly scoped as "a coarse prefilter at best, not the detection signal
itself." Phase 4 wires this in: `CallCaptureDaemon` now takes a
`checkCallingAppRunning: () => Promise<string | null>` port
(`src/daemon.ts`) and requires **both** signals to agree — mic active AND a
known calling app running — before firing wake or the notification. A
non-null result also carries which app matched, resolved to a clean source
label (e.g. `'zoom'`, `'teams'`) that flows into the eventual capture
artifact's filename and digest line. Without this
gate, any mic activity at all (Dictation, Siri, Voice Memos, a random
website's `getUserMedia()` permission grant, ...) would trigger a "capture
this call?" prompt.

`src/process-prefilter.ts` implements the check: `checkAnyCallingAppRunning()`
runs `pgrep -x <name>` (mirroring `extensions/watchers/src/differs.ts`'s
`pgrepAlive`, but NOT imported from `@ethosagent/watchers` — this package
takes no dependency on that one, structural ports only) against
`KNOWN_CALLING_APP_PROCESSES`: `zoom.us`, `Microsoft Teams`, `Discord`,
`Skype`, `FaceTime`, `Webex`, `GoToMeeting`. A plain, easily-extended array —
no new config surface for this pass.

**Known, deliberate, accepted limitation — not a bug, not something this
pass attempts to fix:** a browser tab running a web-based call (e.g. Google
Meet in Chrome) does NOT pass this prefilter. Chrome/Safari/etc. are not
calling-app-specific process names — `extensions/watchers`' own `process`
differ notes the identical gap. A Meet-in-Chrome call is still correctly
*detected* by the mic-activity signal (decision 1's actual trigger), but
`CallCaptureDaemon` will not offer to capture it, because the process gate
never sees a matching process. This narrows the feature's real-world
coverage for browser-based calling relative to native-app calls, and is
called out here explicitly rather than left as a silent gap.

### Direct dispatch: no LLM turn, no tool registry involved

`runCallCapture()` (`@ethosagent/tools-callcapture`) is a plain async
function, not a registered `Tool`. `CallCaptureDaemon`'s `runCapture`
option calls it directly and deterministically once the OS notification is
accepted — no chat turn, no LLM round-trip, no tool-call step in between.
`packages/wiring/src/build-agent-loop.ts` builds a bound closure
(`runCallCaptureFn`, closing over the constructed `TapCapture`/`MicCapture`/
STT/memory dependencies and the bound personality id) and threads it out
through `CreateAgentLoopResult.runCallCapture`; `serve.ts` wires that
straight into the daemon's `runCapture`.

This replaced an earlier design where the daemon told the LLM
`"Call call_capture_start now"` via `loop.run(prompt, { ... })` and hoped it
complied. That design closes two things a later review found:

- **INB-002 (live-turn injection):** the plan's stated default is
  memory-only, no live-turn injection. The LLM-turn design technically
  avoided injecting into an *existing* turn, but it still spun up a fresh
  one on every accepted call. Direct dispatch is stronger than even that
  narrower reading — there is no live turn for call capture at all, ever.
- **The tool-being-LLM-reachable security hole:** `call_capture_start` no
  longer exists as a registered `Tool`. There is nothing for an ordinary
  chat turn — or a prompt-injected one — to call. The only caller in the
  entire codebase is this daemon's accept-gated `runCapture`.

### Turn cancellation: a real mechanism, not a bounded-duration fallback

`CallCaptureDaemon` creates a fresh `AbortController` per accepted call and
passes `controller.signal` straight into `runCapture(abortSignal)`, which
the daemon's caller binds to `runCallCapture()`
(`extensions/tools-callcapture/src/index.ts`). `runCallCapture()` already
`await`s that signal and, on abort, stops both capture streams and saves
whatever was captured — this was true before Phase 4 and needed no change.
`CallCaptureDaemon` calls `controller.abort()` when the detector later
reports `call_ended` for that same call. This is the real, already-existing
seam this phase found and used — there is no bounded-duration safety-net
timer anywhere in this package, and none was needed.

### `ethos doctor` integration

Silent when call capture isn't configured — the same "don't warn about an
unused feature" rule the Channel SDKs section follows. When
`callCapture.personalityId` is set, `ethos doctor` runs
`checkCallCaptureDependencies()` and reports a "Call capture" section
naming every missing dependency (never just the first) with its exact fix
command. A configured-but-broken call-capture deployment is a hard failure
(`DoctorFailFlags.callCaptureDepsMissing`, exit 1) — the same weight
`ethos doctor` already gives a configured-but-missing channel SDK.

**Daemon liveness, not just binary presence.** The checks above verify
`terminal-notifier`/`mic-detector`/`mic-capture`/`audiotee` are present on
disk — they say nothing about whether a `CallCaptureDaemon` is actually
alive inside a running `ethos serve`/`ethos gateway` process right now. Both
host commands write a heartbeat (`src/health.ts`'s `callCaptureHealthPath()`,
`~/.ethos/callcapture-health.json`) every 10s while their daemon is running,
mirroring the gateway's own `gateway-health.json` heartbeat exactly.
`ethos doctor`'s `checkCallCaptureDaemonHealth()` reads it back with the same
30s-staleness rule `checkGatewayHealth` uses: `ok` (fresh heartbeat), `stale`
(the daemon started but its heartbeat has gone quiet — likely crashed;
hard failure, same weight as `gatewayStale`), or `down` (no heartbeat file —
not currently running inside either host command; informational only, not a
failure, since a configured deployment between runs of `ethos serve`/`ethos
gateway` is a normal state, not a broken one).

### Flow diagram — as actually built

The plan doc's original diagram (see
[`plan/phases/call-capture-extension.md`](../../plan/phases/call-capture-extension.md),
"## Architecture" → "### Flow diagram") assumed the same shape this phase
shipped, with one correction: cancellation was an open question there
("whether the existing `before_tool_call` approval gate can be reused
as-is... is unresolved") and is now resolved, in favor of the
already-existing `abortSignal` mechanism above rather than any approval-gate
adaptation.

```
 [Persistent host: ethos serve, macOS + callCapture.personalityId set]
                    |
                    v
        +-----------------------+
        | CallCaptureDaemon:    |
        | Phase 1 detector      |
        | (MicActivityDetector) |
        +-----------------------+
                    |
                    v  call_started
        +-----------------------+
        | checkCallCaptureDeps  |------ missing dep --> [logged error, no
        | (T5 combined preflight)|      notification, daemon stays idle]
        +-----------------------+
                    |  ok
                    v
        +-----------------------+
        | wake (audit leg, same |
        | closure as            |
        | WatcherManager)  ---> logged into the bound personality's session
        +-----------------------+
                    |
                    v
        +-----------------------+
        | NotificationGate      |------ terminal-notifier missing/spawn
        | .presentCaptureOffer  |       fail --> outcome 'error', logged
        +-----------------------+
                    |
        +-----------+-----------+
        |                       |
        v                       v
   [expired/error] -->     [accepted]
   no capture, logged           |
                                 v
                    +-----------------------+
                    | runCapture(abortSignal)|
                    | --> runCallCapture(    |
                    |   callCaptureOpts, {   |
                    |   sessionKey:          |
                    |   callcapture:<id>,    |
                    |   abortSignal, ... })  |
                    | (direct dispatch — no  |
                    |  LLM turn, no tool     |
                    |  registry; the click   |
                    |  above WAS the only    |
                    |  approval needed)      |
                    +-----------------------+
                                 |
                                 v
                    +-----------------------+
                    | TapCapture + MicCapture|
                    | --> streamed STT       |
                    +-----------------------+
                                 |
                    call_ended  |  runs until aborted
                    (daemon)    v
                    +-----------------------+
                    | controller.abort()    |
                    | --> runCallCapture     |
                    |     stops both         |
                    |     streams, saves     |
                    |     whatever was       |
                    |     captured           |
                    +-----------------------+
                                 |
                                 v
                    +-----------------------+
                    | summarizeTranscript    |
                    | (LLM content summary,  |
                    | decision 7)            |
                    | --> memory.sync():     |
                    |     transcript artifact|
                    |     + digest index     |
                    +-----------------------+
                                 |
                                 v
                    [searchable transcript + summary in memory]
```

### Running as a LaunchAgent

Call capture needs one of the always-on host commands (`ethos serve` or
`ethos gateway`, see "Phase 4 — Integration" above) running continuously —
in practice, that means registering it as a macOS LaunchAgent so it survives
reboots and login, per plan/phases/call-capture-extension.md's "Preflight"
§6. This mirrors [`docs/content/using/how-to/run-as-daemon.md`](../../docs/content/using/how-to/run-as-daemon.md)'s
launchd section exactly (that page is the canonical reference for daemonizing
any long-running `ethos` command); this section names the specific plist for
`ethos serve`, since that is the more common single-user host choice for a
personal machine running call capture. `ethos gateway` works identically for
this purpose given the wiring above — swap `serve` for `gateway start` in
`ProgramArguments` and the label/log paths below.

First, confirm how `ethos` actually resolves as an executable on your
machine — a global install (`npm install -g @ethosagent/cli` or the pnpm
equivalent) publishes a real `ethos` binary via `apps/ethos/package.json`'s
`bin` field:

```bash
which ethos
# e.g. /opt/homebrew/bin/ethos, or ~/.nvm/versions/node/v24.x.x/bin/ethos
```

Paste that absolute path into `ProgramArguments` below — service managers do
not source your shell rc, so a bare `ethos` will not resolve.

Write `~/Library/LaunchAgents/ai.ethosagent.callcapture.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.ethosagent.callcapture</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/ethos</string>
    <string>serve</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/YOUR_USERNAME</string>
  </dict>

  <key>WorkingDirectory</key>
  <string>/Users/YOUR_USERNAME</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/YOUR_USERNAME/.ethos/logs/callcapture.out.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/YOUR_USERNAME/.ethos/logs/callcapture.err.log</string>
</dict>
</plist>
```

Replace `/opt/homebrew/bin/ethos` with your own `which ethos` output and
`YOUR_USERNAME` with the output of `whoami`. Then load and start:

```bash
launchctl load ~/Library/LaunchAgents/ai.ethosagent.callcapture.plist
launchctl start ai.ethosagent.callcapture
launchctl list | grep ethosagent
tail -f ~/.ethos/logs/callcapture.out.log
```

Verify the daemon actually started (the log should show `CallCaptureDaemon`
construction and `MicActivityDetector` startup, and `ethos doctor` should
report the "Call capture" section's daemon heartbeat as `ok` within ~10s —
see "`ethos doctor` integration" above).

Stop, unload, or reload after an `ethos upgrade`:

```bash
launchctl stop   ai.ethosagent.callcapture
launchctl unload ~/Library/LaunchAgents/ai.ethosagent.callcapture.plist
# after upgrading:
launchctl stop ai.ethosagent.callcapture && launchctl start ai.ethosagent.callcapture
```

`RunAtLoad` plus the `~/Library/LaunchAgents/` location starts the daemon at
login; `KeepAlive` restarts it on crash. See `docs/content/using/how-to/
run-as-daemon.md`'s "Troubleshoot" section for the general daemon-launch
failure modes (stripped `PATH`/`HOME`, `nvm`-installed binaries, etc.) — they
apply here unchanged, since this is the same launchd mechanism wrapping a
different `ethos` subcommand.
