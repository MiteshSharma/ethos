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
"Phase 4 — Integration" below for the finished wiring. A post-Phase-4 fix
(**"Per-process detection"**, near the end of this file) later replaced the
per-DEVICE detection approach described in the next section with a
per-PROCESS one, after a real stuck-recording bug in production use — read
that section for the current design; the section immediately below is kept
for history and is honest about what was true when Phase 1 shipped, not
about how detection works today. A second post-Phase-4 fix (**"Native
notification helper"**, also near the end of this file) later replaced
Phase 2's `terminal-notifier` dependency with a native `UserNotifications`-
based helper, after a real reported dark-mode banner-legibility bug — the
Phase 2 section below is likewise kept for history, not as a description of
today's notification mechanism.

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

- **`native/mic-detector.swift`** — the compiled watcher. **As of the
  per-process detection fix (see that section below), this watches known
  calling apps' individual audio activity, not the default input device** —
  the description immediately below is Phase 1's original, now-superseded
  per-device design, kept for history; see "Per-process detection" for the
  current one. Originally: watched the current default input device's
  running state, and separately watched
  `kAudioHardwarePropertyDefaultInputDevice` on the system object so it
  re-attached to a new device if the user switched inputs mid-run (e.g.
  plugging in headphones) without missing a state change. Emits one line of
  newline-delimited JSON per event to **stdout** — the current shape (see
  "Per-process detection" for the full contract):
  - `{"event":"initial","running":false,"at":"...Z"}` — the starting state,
    emitted once before entering the run loop, so the Node wrapper doesn't
    have to guess. Carries `"source"` when `running` is `true`.
  - `{"event":"running_changed","running":true,"source":"zoom.us","at":"...Z"}`
    — on every observed aggregate transition. `"source"` is the raw
    known-calling-app process name that triggered it (present only when
    `running` is `true` — an aggregate `false` doesn't name a single app).
  - `{"event":"error","message":"..."}` — on an API failure, then exits
    non-zero (currently unused in practice by the per-process design — see
    "Per-process detection" for why).

  Runs until killed (`SIGTERM`) — no fixed timeout in the shipped binary (a
  timeout was only used for the manual research probe that validated the
  original per-device approach before this package existed).

- **`src/detector.ts`** — `MicActivityDetector`, the Node wrapper. Spawns the
  compiled binary, parses its NDJSON stdout, and translates the raw
  `initial`/`running_changed` signal into the public
  `call_started` / `call_ended` / `error` contract. `call_ended` is debounced
  (default 2000ms, configurable) because the underlying signal can flicker
  for sub-second gaps — a bare state read would falsely report a call
  "ending" on every flicker. `call_started` is never debounced; it fires the
  instant the first `running: true` is observed, carrying a `source` field
  (the clean label from `process-prefilter.ts`'s `sourceLabelForProcessName`,
  e.g. `'zoom'`) resolved from the native event's raw process name. The
  binary spawn is injectable (`spawnFn`) so unit tests run entirely against
  a fake child process — no real hardware, no real mic, no compiled binary
  required in CI (which has no audio device anyway).

- **`src/detect-cli.ts`** — the Phase 1 manual-verification tool. Runs the
  real detector against the real compiled binary and logs every event with a
  timestamp. Standalone dev tool, not wired into `ethos`.

- **`src/preflight.ts`** — `checkCallCaptureDependencies()`'s combined
  dependency preflight, including a plain `existsSync` presence check for
  the compiled `capture-offer-card` binary (native/bin/), same as
  `mic-detector`/`mic-capture`/`audiotee`. **This file used to also export
  `checkNotificationHelperAvailable()`**, a binary-presence +
  notification-authorization-status check for the (now twice-superseded)
  `terminal-notifier` -> `notification-helper` accept-gate implementations
  — the description that used to be here, kept for history below, is no
  longer accurate: see "Fix — native capture-offer card, retiring
  `notification-helper`" for why that whole authorization dimension no
  longer applies. Never a swallowed `spawn ENOENT` either way — resolves a
  typed `{ ok: false; missing; errors }` naming the fix (`pnpm ... run
  build:native`) for whichever binary is absent.

- **`src/notification.ts`** — `NotificationGate`, the "show + wait for
  accept" surface. `presentCaptureOffer({ callId, title, message, source? })`
  spawns the compiled `capture-offer-card` binary (one persistent process
  per offer — see "Fix — native capture-offer card, retiring
  `notification-helper`" below), a custom AppKit card immune to system
  notification chrome theming, with its own Start/Skip buttons and an "x"
  dismiss. Returns a handle: `waitForOutcome()` resolves `{ outcome:
  'accepted' }` on Start, `{ outcome: 'expired' }` on Skip/"x"/`expire()`
  (a real call-ended or explicit decline collapse to the same non-accepted
  outcome — see that section for why a separate `'declined'` variant wasn't
  added), and any spawn failure resolves `{ outcome: 'error'; message }`
  immediately instead of throwing. Supersedes this file's original
  `terminal-notifier`-based implementation and its `notification-helper`
  (`UNUserNotificationCenter`) successor — see "Fix — native capture-offer
  card, retiring `notification-helper`" for the full story.

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

### Process prefilter (decision 1's coarse prefilter — SUPERSEDED, folded into the detector)

**As originally wired in Phase 4** (kept here for history — see "Per-process
detection" below for the current design): decision 1 describes two signals:
mic-in-use (Phase 1's detection trigger) and a "coarse prefilter" using
process/app detection, explicitly scoped as "a coarse prefilter at best, not
the detection signal itself." Phase 4 wired this in as a separate
`CallCaptureDaemon` port, `checkCallingAppRunning: () => Promise<string |
null>` (`src/daemon.ts`), backed by `src/process-prefilter.ts`'s
`checkAnyCallingAppRunning()`, which ran `pgrep -x <name>` against
`KNOWN_CALLING_APP_PROCESSES` and required **both** signals — mic active AND
a known calling app running — before firing wake or the notification.

**Current state:** the per-process detection fix (below) made this separate
check redundant and it has been removed. The native detector now only ever
watches known calling apps in the first place (via `NSWorkspace`, not
`pgrep`), so a `call_started` event is already scoped to one by
construction — there is no longer a "mic active, but no known app running"
case for a downstream gate to filter out. `process-prefilter.ts` still
exists, narrowed to the `KNOWN_CALLING_APP_PROCESSES` registry and the
raw-name-to-clean-label lookup (`sourceLabelForProcessName`), which
`detector.ts` now uses directly when mapping the native detector's
`call_started` events.

**Known, deliberate, accepted limitation — unchanged by this fold-in, not a
bug, not something either the old or new design attempts to fix:** a browser
tab running a web-based call (e.g. Google Meet in Chrome) is still not
detected. Chrome/Safari/etc. are not calling-app-specific processes, and
neither `pgrep` name-matching nor `NSWorkspace` + per-process CoreAudio can
distinguish a calling tab from any other tab — `extensions/watchers`' own
`process` differ notes the identical gap. This narrows the feature's
real-world coverage for browser-based calling relative to native-app calls,
and is called out here explicitly rather than left as a silent gap.

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
`capture-offer-card`/`mic-detector`/`mic-capture`/`audiotee` are present on
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
        | NotificationGate      |------ capture-offer-card missing/spawn
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

## Fix — per-process detection (2026-08-18)

### The bug, confirmed live in production use

A user ran the shipped Phase 1-4 feature end-to-end: joined a real Zoom
call, got the notification, accepted it, capture started correctly. They
then **left the Zoom call but kept the Zoom app open** (did not Quit). The
capture never stopped — `audiotee`/`mic-capture` ran unattended for many
minutes after the call ended, because `call_ended` never fired.

**Root cause, confirmed empirically**: `kAudioDevicePropertyDeviceIsRunningSomewhere`
(what `native/mic-detector.swift` watched, per the "Approach: CoreAudio, not
`ioreg`" section above) is a **system-wide, device-level** flag — "is
anything using this input device at all." Zoom keeps it warm in the
background outside of active calls, so it never returns to `false` once
Zoom has touched the mic, regardless of whether a call is actually active.
Quitting Zoom entirely released it, but "quit the app to stop a stuck
recording" was rejected as a workaround, not a fix.

### The fix: per-PROCESS audio activity, not per-DEVICE

CoreAudio has a more precise API surface: translate a PID to its
`AudioProcess` object, then watch that SPECIFIC process's own running-input
state.

- `kAudioHardwarePropertyTranslatePIDToProcessObject` (on
  `kAudioObjectSystemObject`, `kAudioObjectPropertyScopeGlobal`) —
  translates a `pid_t` to an `AudioObjectID` representing that process
  within the audio HAL.
- `kAudioProcessPropertyIsRunningInput` (on that process's `AudioObjectID`)
  — a `UInt32` boolean: is this specific process currently running an input
  stream.

### Validation performed, and honestly which tier

**Mechanism tier (strongest tier achieved — no live Zoom call was available
in the validation environment):** a controlled two-process test proved the
exact property this fix depends on. A long-running `ffmpeg` process (B) held
the default input device the entire time. A second process (a small
`AVAudioEngine`-based "mic-toggler" harness, standing in for "an app that
opens the mic for a call, then leaves the call but stays running") captured
for 5 seconds, then **stopped its own engine while staying alive** for
another 10 seconds before exiting — simulating "leave the call, keep the app
open" precisely. A probe watching process A's own
`kAudioProcessPropertyIsRunningInput` (translated from its PID) observed:
`true` while A was capturing, transitioning to `false` within one poll tick
(~32ms) of A stopping its own engine — **while A was still alive** and
**while process B was still actively holding the device** (confirmed via
`kAudioDevicePropertyDeviceIsRunningSomewhere` staying `true` throughout).
This is exactly the property the device-wide flag lacked, proven against a
second, independent process holding the device the whole time.

**Empirical finding that changed the design — event listeners don't fire for
Process objects:** the original per-device code used
`AudioObjectAddPropertyListenerBlock` for genuinely event-driven detection,
and that mechanism still works fine for Device objects. The equivalent
listener on a Process object was tested and found NOT to fire: registration
succeeded (`status == noErr`) for `kAudioProcessPropertyIsRunningInput` and
`kAudioProcessPropertyIsRunning`, across both `kAudioObjectPropertyScopeGlobal`
and `kAudioObjectPropertyScopeInput` (three combinations total), but the
callback was never observed to fire during a real, confirmed transition —
while polling the identical property on the identical object correctly
observed every transition within one tick. This is not treated as a bug in
this package; `audiotee`'s own vendored README already carries an "API
Instability Warning" for this general area of CoreAudio (Process/Tap
objects, macOS 14.2+). Consequence: `native/mic-detector.swift` **polls**
the per-process property (every 2s), but only for the bounded set of
currently-running known calling apps (typically 0-1), and only while at
least one is open — app PRESENCE (which known apps are running, their PIDs)
is still fully event-driven via `NSWorkspace`, so the idle cost (no known
app open) stays at zero.

**A significant, honestly-reported residual finding:** while testing the
shipped binary against real processes on the validation machine, a genuine,
already-running `zoom.us` background process (not started by this testing —
elapsed ~26 minutes, holding open UDP sockets to a Zoom media relay on port
8801) reported `kAudioProcessPropertyIsRunningInput` **and**
`kAudioProcessPropertyIsRunningOutput` as `true`, continuously, with no
call visibly active from the outside. The validation environment has no
Accessibility/Screen Recording permission and could not capture a
screenshot or read window titles, so it was **not possible to conclusively
determine** whether this reflected a genuinely stuck "left a call, audio
engine didn't release" state (the same class of symptom the device-wide fix
was built to solve, just one layer deeper) or a benign always-on
"pre-warmed audio path" some calling apps may keep regardless of call state.
**This is reported as an open, unresolved risk, not swept under the rug:**
the per-process signal is a strict, proven improvement over the device-wide
one at the mechanism level (see above), but it may not be a complete fix for
every calling app's specific internal behavior. Anyone deploying this should
verify with a real call on their own machine: leave a call with the app
still open and confirm `mic-detector`'s aggregate returns to `false` within
a few seconds.

### Bounded safety net, added because of that residual finding

Because of the finding above, `CallCaptureDaemon` (`src/daemon.ts`) now
carries a **bounded maximum-capture-duration safety net** (default 4 hours,
configurable via `maxCaptureDurationMs`) **underneath** the real
`call_ended` signal — never a substitute for it. If `call_ended` never
arrives for an in-flight capture (whether because a given app's per-process
signal itself gets stuck warm, or any other reason), the safety-net timer
aborts the capture and logs a warning naming exactly what happened. This is
a deliberately different situation from the one a prior review round
rejected a bounded-duration fallback for ("don't build this as a substitute
for a real cancellation mechanism") — this is a net under a best-effort
precise signal, not instead of one, added in direct response to a concrete,
reproducible piece of evidence that the precise signal alone might not be
airtight for every app.

### Known-app tracking: `NSWorkspace`, not `pgrep` — and the old process-prefilter folded in

`native/mic-detector.swift` now tracks known calling apps (the same list
`process-prefilter.ts`'s `KNOWN_CALLING_APP_PROCESSES` has always had:
`zoom.us`, `Microsoft Teams`, `Discord`, `Skype`, `FaceTime`, `Webex`,
`GoToMeeting`) via `NSWorkspace.shared.runningApplications` for the initial
scan and `NSWorkspace.shared.notificationCenter`'s
`didLaunchApplicationNotification`/`didTerminateApplicationNotification` for
reactive, event-driven tracking as apps launch and quit — attaching/detaching
a per-process poll entry as each known app comes and goes, rather than
watching one fixed thing for the binary's whole lifetime.

**Match key, verified empirically:** `NSRunningApplication.executableURL?.lastPathComponent`
— NOT `.localizedName` or `.bundleIdentifier` — is the correct match key.
Checked against three installed apps' actual `Info.plist`:
`CFBundleExecutable` for `zoom.us.app` is `zoom.us`, for `Discord.app` is
`Discord`, for `FaceTime.app` is `FaceTime` — identical, in every case, to
the process name `pgrep -x` would have matched. This conveniently means the
existing `KNOWN_CALLING_APP_PROCESSES` list didn't need to change at all —
only how it's matched did. (`.bundleIdentifier` was deliberately avoided:
some of these apps, notably Teams, have shipped multiple bundle IDs across
"classic" vs. "new" client generations, which the executable name is more
stable against.)

**Multiple known apps open at once:** each tracked app's `running` state is
independent; the aggregate "a call is active" is `true` if ANY tracked app
shows running input, and only returns to `false` once ALL of them do —
`native/mic-detector.swift`'s `recomputeAggregate()`.

**The old `pgrep`-based process-prefilter gate is gone, not duplicated:**
see "Process prefilter (decision 1's coarse prefilter — SUPERSEDED, folded
into the detector)" above. The native detector only ever watches known
calling apps in the first place, so `CallCaptureDaemon` no longer takes a
separate `checkCallingAppRunning` port — every `call_started` event already
carries the triggering app's clean source label (`source` field, mapped by
`detector.ts` via `sourceLabelForProcessName`), which is at least as precise
as the old pgrep match (the daemon now knows exactly which app's PID
triggered the event, not just that some pgrep pattern matched somewhere).

**Unchanged by this fix:** the browser-based-call blind spot (Meet in
Chrome, etc. — browsers were never in `KNOWN_CALLING_APP_PROCESSES` and
still aren't, see the process-prefilter section above), the notification/
accept-gate mechanism (Phase 2), the capture pipeline itself (Phase 3's
`tap-capture.ts`/`mic-capture.ts`/`transcript-session.ts`), and the
memory-write/artifact/digest logic (`extensions/tools-callcapture`) except
that source labels can now be at least as precise as before, never less.
The floating recording-indicator UI (a separate, larger follow-up) remains
out of scope here too.

## Fix — native notification helper, replacing terminal-notifier (2026-08-18)

### The bug, and the friction that preceded it

A real user reported the `terminal-notifier` banner rendering with white,
hard-to-read text on their machine — almost certainly a Light/Dark Mode
re-theming failure. `terminal-notifier` is a third-party CLI we don't
control the source of and which gives no styling API, so this wasn't
something this package could special-case a color fix for. It was also the
second time `terminal-notifier` had been a source of friction: see
"Troubleshooting: notification permission granted but no banner appears"
above, a real production bug that needed a `killall NotificationCenter
usernoted` workaround.

### The fix: `UNUserNotificationCenter` directly, owned the way `mic-detector`/`mic-capture` already are

`native/notification-helper.swift` uses Apple's modern `UserNotifications`
framework directly instead of shelling out to `terminal-notifier`. Apple's
own templated banners are guaranteed to render correctly themed for the
system's current appearance — this fixes the reported bug as a side effect
of using the current-generation API, not a bespoke color hack. It also lets
the click be observed **inside the same process**, via
`UNUserNotificationCenterDelegate`'s `didReceive response:` callback —
`click-listener.ts` (the local loopback HTTP bridge that existed solely to
receive `terminal-notifier -execute`'s shell-out callback) is gone, along
with its test. `notification.ts`'s public contract
(`NotificationGate.presentCaptureOffer()` → `CaptureOfferHandle` with
`waitForOutcome()`/`expire()`) is unchanged — this is a pure internal
implementation swap. `daemon.ts` needed **zero changes**: it only ever
depended on that contract.

### App-bundle requirement — empirically confirmed, not assumed

A bare command-line Mach-O executable calling `UNUserNotificationCenter
.current()` **crashes immediately**:

```
*** Terminating app due to uncaught exception 'NSInternalInconsistencyException',
reason: 'bundleProxyForCurrentProcess is nil: mainBundle.bundleURL file://...'
```

Verified directly on a real machine (macOS 26.2, Darwin 25.2). Wrapping the
same binary in a minimal `.app` bundle with a `CFBundleIdentifier` in its
`Info.plist` fixes this — no crash, a real `UNUserNotificationCenter`
instance. This is the same reason `terminal-notifier` itself ships its own
app bundle (`fr.julienxx.oss.terminal-notifier` — see the Troubleshooting
section above), not a difference between this helper and that one.

A second, less obvious requirement was also found empirically: the bundle
must be registered with Launch Services (`lsregister`) **from a stable,
non-ephemeral path**. The identical bundle run from `/private/tmp` failed
with `usernoted: Failed to find or validate client of identifier ...` in
the unified log (`log show`); the same bundle run from `/Applications` or a
normal path under `$HOME` (including this package's own `native/bin/`) was
correctly validated, and its authorization request actually reached
`usernoted` (status transitioned away from `notDetermined`). Neither
`AppKit` nor `NSApplication` was needed for any of this — plain
`Foundation` + `UserNotifications` is enough, contrary to the concern that
some `UserNotifications` APIs historically required a full app-bundle
*event loop* (not just a bundle identifier) to work from a bare executable.

`scripts/build-notification-helper.sh` (invoked from `build:native`, same
as `mic-detector`/`mic-capture`) does the wrapping: compiles the binary into
`native/bin/notification-helper.app/Contents/MacOS/notification-helper`,
writes `Info.plist` (`CFBundleIdentifier: ai.ethosagent.callcapture
.notification-helper`, `LSUIElement: true` — no Dock icon, no menu bar),
ad-hoc codesigns it (`codesign --sign -`, no paid Developer ID needed for a
local dev build), and registers it with Launch Services immediately so the
very first run doesn't race Spotlight/Launch Services' own lazy indexing.

### App icon

The notification banner shows the real Ethos brand icon (the round
blue-ring mark), not a generic default — `scripts/build-notification
-helper.sh` copies `apps/desktop/build/icon.icns` (the same icon the
desktop app ships, built from `apps/desktop/assets/brand/icon-1024.png`)
into the bundle's `Contents/Resources/icon.icns` and sets
`CFBundleIconFile`/`CFBundleIconName` in `Info.plist`. Verified empirically:
rendering the real built bundle's Launch-Services-resolved icon via
`NSWorkspace.icon(forFile:)` produced a 1024×1024 PNG that is visibly the
Ethos ring (byte-identical, 268355 bytes, to the same render of an earlier
test bundle wired the same way) — not a blank-document or generic-
executable placeholder, and not the same render as an unrelated app's icon
(`Terminal.app`, compared for contrast, different bytes and image). This is
the same LaunchServices icon-
resolution mechanism Finder/Dock/Spotlight/notification banners all share,
so the mechanism proof transfers; only the literal banner's rendered pixels
still need a human's eyes to confirm, same caveat as the click-bridge below.

### Protocol

One notification per process invocation (mirrors `mic-capture.swift`'s
one-process-per-session model, not `mic-detector.swift`'s persistent-
multi-event one) — simpler than routing a dismiss-by-identifier command
across multiple concurrently-open notifications in one process, and a
natural fit since `NotificationGate.presentCaptureOffer()` already mints
one offer per call.

```
argv:
  notification-helper --check-status          side-effect-free preflight
  notification-helper <callId> <title> <msg>  show one notification

stdout (NDJSON, one line per event):
  {"event":"status","status":"authorized"|"denied"|"notDetermined"}
  {"event":"shown"}
  {"event":"clicked","callId":"..."}   exits 0 right after
  {"event":"authDenied"}               not authorized; exits 1
  {"event":"error","message":"..."}    exits 1
```

**No stdin command channel.** Withdrawing a still-pending/delivered
notification is done by sending `SIGTERM` — `notification-helper` withdraws
both its pending and delivered notification (`removePendingNotification-
Requests`/`removeDeliveredNotifications`) before exiting cleanly. This is
simpler than a `{"command":"dismiss"}` stdin protocol and needs no
identifier disambiguation (there's only ever one notification per process),
and it's exactly `SpawnedChild`'s existing `kill()` idiom from
`detector.ts` — `NotificationGate`'s `expire()` calls `child.kill('SIGTERM')`
and awaits the process's own exit before resolving `'expired'`, confirming
the withdrawal actually ran (mirroring the old `terminal-notifier -remove`
implementation awaiting its exit the same way).

### Authorization — what was verified, and what honestly wasn't

`requestAuthorization` is called on first use if not already determined —
this is the genuine system "Allow Notifications from Ethos?" dialog,
interactive the way Camera/Microphone prompts already are for this
package's other native helpers, unlike `terminal-notifier` which apparently
never triggered it. Verified via the unified log that the request pipeline
works end-to-end once the app-bundle/Launch-Services conditions above are
met: `usernoted` recognizes the client and the authorization status
genuinely transitions away from `notDetermined`. What could **not** be
verified in this environment: this exec session has no interactive Aqua
session attached (confirmed separately — `open -W` on the bundle fails with
"Unable to block on applications"), so macOS auto-denies the request rather
than presenting the dialog to a human. A real user running `ethos serve`/
`ethos gateway` from their own interactive Terminal session should see the
real dialog, the same way every other macOS app using
`UNUserNotificationCenter` does. The same honesty standard applies here as
applied to the old click-bridge verification above: the plumbing is
provably correct end-to-end; only a human clicking "Allow" on a real dialog,
and then a real banner, needs the repo owner's own eyes to confirm.

### `terminal-notifier` fully retired from this package's runtime path

No remaining runtime dependency on it — `preflight.ts`'s
`checkCallCaptureDependencies()` checks `notification-helper` (binary
presence + authorization status) instead, `ethos doctor`'s "Call capture"
section names it in its dependency list, and the historical Phase 2
narrative above is left as-is (kept for history, per this file's own
convention — see the top of this file).

### Investigated, not a code bug: "whitish grey layer" on first banner, correct on click (2026-08-19)

A real user tested the new `notification-helper` banner and reported: *"there
is a whitish grey layer on top of it, when i click on it then it comes out to
be correct of dark grey background."* Given this immediately follows the
`terminal-notifier` dark-mode-legibility fix above, it needed a real
investigation, not an assumption either way.

**Ruled out as the cause, by reading `notification-helper.swift` and Apple's
`UNMutableNotificationContent` API surface:**

- `content.sound = .default` and no explicit `interruptionLevel` — the
  default interruption level is `.active`, which is the standard full-banner
  presentation; there is no undocumented "muted" interruption level, and
  `.timeSensitive` (which *would* require the
  `com.apple.developer.usernotifications.time-sensitive` entitlement this
  ad-hoc-signed, non-provisioned bundle doesn't have, and would silently
  downgrade to `.active` without it per Apple's docs) governs whether a
  notification breaks through Focus/DND, not its background material.
  Setting it explicitly would be a no-op for this symptom.
- No `categoryIdentifier`/registered `UNNotificationCategory` — this affects
  which action buttons a banner offers, not its background rendering.
- The `CFBundleIconFile`/`CFBundleIconName` icon added earlier this session —
  per Apple's notification layout, the app icon renders in its own fixed
  thumbnail slot, never as a background layer behind the banner's own chrome.
  Confirmed by re-reading the icon-wiring code in
  `scripts/build-notification-helper.sh`: it only ever touches
  `Contents/Resources/icon.icns`, nothing content/appearance-related.
- An Apple "delivery quietness" heuristic that mutes a *brand-new, untrained*
  app's banners until a few interactions "train" it — this was the leading
  hypothesis going in, but no Apple documentation, WWDC session, or developer
  forum thread supports it as a real mechanism. `Reduce Interruptions` Focus
  and notification summaries are real and interaction-adaptive, but they
  govern *whether/when* a notification is delivered, and are user-opt-in
  Focus features — not an automatic per-bundle-identity visual toning that
  self-resolves after a handful of clicks.

**What the evidence actually points to:** this environment is macOS 26.2
("Tahoe" — see the `Darwin 25.2` build note earlier in this doc), which
shipped a system-wide "Liquid Glass" material: a translucent, glass-like
rendering applied throughout system chrome, explicitly including
notification banners, per Apple's own design documentation. This is widely
and publicly documented (Apple's own 2025-06 design announcement; TidBITS
and MacRumors coverage of the macOS 26.1 update) as causing washed-out,
lower-contrast "whitish" appearance complaints broadly enough that Apple
shipped a direct fix for it in macOS 26.1: `System Settings → Appearance →
Liquid Glass → Clear/Tinted`, where `Tinted` raises the material's opacity
specifically to address this class of readability complaint. Critically,
this is OS-level system chrome — `UNMutableNotificationContent` exposes no
property that touches it (title, body, sound, `interruptionLevel`,
`categoryIdentifier`, attachments, badge — none of these are a background
material knob). This is the same "we don't control the source of the
banner's chrome" situation `terminal-notifier`'s original bug lived in, just
a different, OS-version-specific layer on top of it: the `UNUserNotification-
Center` migration's promise ("Apple's own templated banners are guaranteed
to render correctly themed") is still true and still confirmed by this same
report — the user's own words are that clicking through reveals the
*correct* dark grey background, i.e. the underlying Dark Mode theming this
package's fix was for is intact. The transient glass layer on top is a
separate, newer rendering behavior introduced by this OS version, not a
regression of it.

**Conclusion: expected macOS 26 system behavior, not a code bug.** No code
change was made — `notification-helper.swift` is unchanged from what's
described above. If a user wants a more opaque banner, the fix is on their
end: `System Settings → Appearance → Liquid Glass → Tinted`. This is
consistent with this package's standing principle (see the
`terminal-notifier` fix above) of not reaching for a bespoke color hack over
system-rendered chrome we don't own.

## Fix — native capture-offer card, retiring `notification-helper` (2026-08-19)

The user-reported "whitish grey" Liquid Glass symptom above was investigated
and correctly diagnosed as expected OS behavior, not a code bug — but the
System Settings workaround it points to did NOT resolve it for this user in
practice. That's the second time a system-owned notification surface has
been a source of friction in this package (`terminal-notifier`'s theming bug
was the first), and both times the root problem is the same: this package
doesn't control the rendering of chrome it doesn't draw itself. A screenshot
of Granola's own "Meeting detected" UI made the alternative obvious —
Granola doesn't use a system notification for this at all. It draws its own
always-on-top card: a white rounded card with a headline, a subtitle naming
the detected app, its own icon + action label, and Start/Skip buttons —
completely immune to system notification chrome theming because there is no
system chrome involved.

### The fix: `native/capture-offer-card.swift`, a custom AppKit window

Mirrors `capture-indicator.swift`'s category exactly (a real Cocoa event
loop — `NSApplication.shared` + `setActivationPolicy(.accessory)` + an
`NSApplicationDelegate` + `app.run()` — not the bare `RunLoop.main.run()`
the headless detector/capture binaries use), and reuses that file's
proven patterns rather than re-deriving them:

- **Draggable, bottom-right by default, position-persisted** — the exact
  same manual `mouseDown`/`mouseDragged` override `capture-indicator
  .swift`'s `BadgeView` uses, for the exact same reason:
  `isMovableByWindowBackground` does not reliably move this style of
  borderless/nonactivating panel (proven there via synthetic
  `NSApplication.sendEvent` injection — not re-proven here, just reapplied).
  Position persistence reuses AppKit's own frame-autosave mechanism, same as
  the badge.
- **Non-activating, all-Spaces-visible** — same `NSPanel` styling
  (`.borderless`, `.nonactivatingPanel`, `.floating` level,
  `.canJoinAllSpaces` + `.fullScreenAuxiliary`), `orderFrontRegardless()`
  never `makeKeyAndOrderFront(_:)` — never steals focus from whatever
  calling app (Zoom, etc.) is frontmost, and stays visible even if that app
  is running fullscreen in its own Space.
- **Bare binary, no app bundle** — unlike `notification-helper.swift`,
  nothing here touches `UNUserNotificationCenter`, so none of that file's
  `CFBundleIdentifier`/Launch-Services requirements apply.
  `capture-indicator.swift` already proves plain AppKit windows work fine
  from a bare `swiftc`-compiled Mach-O executable in this package; this
  binary is built the same way (`swiftc ... -framework AppKit -framework
  Foundation`), with no wrapping script.
- **Forced light appearance, fixed colors** — `panel.appearance =
  NSAppearance(named: .aqua)` plus literal (never semantic/dynamic) RGB
  color values throughout. This is the actual mechanism that makes the
  "immune to system theming" promise true: a dynamic color like
  `.labelColor` resolves to near-white under system Dark Mode, which
  painted onto this card's own fixed white background would silently
  reproduce a white-on-white rendering — the exact class of bug this whole
  line of fixes exists to escape. See the file's header comment for the
  full reasoning.

See `native/capture-offer-card.swift`'s header comment for the complete
design writeup (protocol, brand-icon resolution, why one process per offer
rather than per capture session).

### `notification-helper` fully retired, not kept as a backup

Considered and rejected: keeping `notification-helper.swift` running
alongside the card as a secondary/backup signal, on the theory that a
system notification can register (with a sound) even when the user isn't
looking at any window. Decided against, for three reasons:

1. **Granola's own reference design doesn't hedge this way** — this feature
   exists specifically to match that UX, and Granola ships exactly one
   accept surface.
2. **The environments where each surface can appear are identical** — both
   require a live, logged-in Aqua session; there is no scenario where the
   system notification would show but the floating, all-Spaces-visible,
   `.floating`-level card wouldn't.
3. **Running both means coordinating two independent processes racing to
   resolve the same offer.** It's workable (both could feed the same
   `resolveOnce` guard `notification.ts` already has), but it's real
   ongoing complexity for a benefit that reason 2 says is close to zero.

The one genuinely real gap this leaves — a silent card is easier to miss
than a system banner if the user truly isn't looking at the screen — is
covered instead by a short `NSSound` played on the card's appearance
(`NSSound(named: "Glass")`, a standard bundled macOS alert sound, not a
custom asset). This needs no second process, no coordination logic, and no
risk of the two surfaces ever disagreeing about the outcome.

Concretely, this is now the **second** supersession for this package's
accept-gate surface (`terminal-notifier` -> `notification-helper` ->
`capture-offer-card`). Unlike the first supersession — where
`notification-helper.swift` was left on disk with its narrative preserved
as history — `notification-helper.swift` and its build script
(`scripts/build-notification-helper.sh`) have been deleted outright, along
with `checkNotificationHelperAvailable`/`NotificationHelperCheckResult` and
friends from `preflight.ts`. The Phase 2 and "native notification helper"
sections above are kept as-is for the historical record (this file's
standing convention — see its top section), but nothing in the current
runtime path references the deleted files anymore:
`checkCallCaptureDependencies()` checks `capture-offer-card`'s binary
presence with the same plain `existsSync` pattern every other native binary
in this package gets — there is no authorization-status dimension to check
anymore, since a plain AppKit window needs no OS permission at all.

### Outcome contract: `declined` stays `'expired'`, not a new variant

The card's Skip button (and its "x" dismiss) gives an explicit decline
signal that the old click-only notification never had — today, "not
accepted" collapses `expired` (call ended unanswered) and an implicit
non-click into the same bucket. A `'declined'` outcome would be more
precise, but it was deliberately NOT added: `CaptureOfferOutcome` is
imported by `daemon.ts`, and `handleCallStarted`'s reaction to it is
`if (outcome.outcome === 'accepted') {...} if (outcome.outcome ===
'expired') {...} else {...outcome.message...}`. A third non-`accepted`
member would make that `else` branch fail to typecheck (it assumes
`error`'s `message` field), forcing a real `daemon.ts` change to add an
explicit branch. `daemon.ts`'s actual reaction to `'declined'` would be
identical to `'expired'` anyway (log, go idle) — the extra type-level
precision isn't worth a `daemon.ts` change for zero behavioral gain, so
`capture-offer-card`'s `{"event":"declined"}` resolves the existing
`'expired'` outcome. See `notification.ts`'s inline comment at that
`switch` case for the same reasoning, kept next to the code it explains.

### Threading the source label through: the one deliberate `daemon.ts` line

The rest of this swap needed zero `daemon.ts` changes, matching the
`terminal-notifier` -> `notification-helper` precedent exactly. Showing the
detected app name as the card's subtitle (matching Granola's plain "Zoom"
subtitle) is the one exception: `source` only exists in `handleCallStarted`'s
local scope, and `PresentCaptureOfferOptions` never carried it before. The
fix is the smallest version of this that works: `source` was added as a new
optional field on `PresentCaptureOfferOptions`/`CallCaptureNotificationGatePort`
(additive, not a breaking change to either type), and `daemon.ts`'s existing
`presentCaptureOffer({callId, title, message})` call site gained one line —
`source,` — using a variable that was already in scope for `handleAccepted`/
`runCapture` a few lines below. `title`/`message` are passed unchanged and
are no longer read by `capture-offer-card`'s own fixed UI text, but are kept
on the type because `DesktopNotificationGate`'s own Electron-based card
(`apps/desktop/src/main/call-capture-notification-gate.ts`, a sibling
implementation of this same contract) still renders them into its own HTML.

### Verification performed

- **Rendered to a real PNG, no Screen Recording permission needed** — same
  `NSView.bitmapImageRepForCachingDisplay`/`cacheDisplay` technique
  `capture-indicator.swift`'s own verification pass established. The card's
  real layout code (icon, headline, subtitle, the "Capture" row, Skip/Start
  buttons) was rasterized off-screen and written to PNG, once with a source
  label ("Zoom") and once without (subtitle correctly omitted). Confirmed by
  eye: a genuinely rounded-corner white card (checked at the pixel level too
  — the top-left corner pixel is fully transparent, alpha 0, while pixels a
  few points inset are opaque white, confirming the rounded-rect clip is
  real and not just a flat rectangle), bold black headline, grey subtitle,
  the Ethos brand icon, a blue filled "Start" button with legible white
  bold text, and a plain grey "Skip" button — no white-on-white or
  low-contrast rendering anywhere, because nothing here is drawn by the
  system.
- **Drag verified via synthetic event injection, not just "should work"** —
  a real `NSPanel` was built with the card's exact drag-handling view, and
  real `NSEvent.mouseEvent` down/dragged/up events were posted through the
  real `NSApplication.sendEvent(_:)` dispatch path (the same technique
  `capture-indicator.swift`'s own draggable-badge fix used to disprove
  `isMovableByWindowBackground` and prove the manual override). Result: a
  drag gesture of (dx: 40, dy: -25) in window-local coordinates moved the
  panel's `frame.origin` by exactly (40, -25) — confirmed by comparing the
  panel's frame before and after, not by inspecting the drag code and
  asserting it must work.
- `pnpm --filter @ethosagent/platform-callcapture run build:native` compiles
  cleanly end to end (all four binaries: `mic-detector`, `mic-capture`,
  `capture-indicator`, `capture-offer-card`).
- Full repo `pnpm check` (typecheck + lint + test) passes.

## Floating recording indicator (plan/phases/call-capture-desktop-ux.md)

The follow-up flagged above: a small, draggable, circular on-screen badge
that appears the moment `CallCaptureDaemon` accepts a capture and disappears
the moment it ends — the only on-screen feedback the CLI-daemon path
(`ethos serve`/`ethos gateway`) has that something is actually recording.
The desktop app has its own, separate Electron `BrowserWindow`-based
indicator (`apps/desktop/src/main/call-capture-pill.ts`); this is the
headless-CLI analog, since a bare Node process has no `BrowserWindow`
available.

**`native/capture-indicator.swift`** — a different category from every
other native helper in this package. `mic-detector.swift`/`mic-capture.swift`
are headless CLI tools driven by a bare `RunLoop.main.run()`; this one shows
a real, draggable, hover-tracking `NSWindow`, which needs the full Cocoa
event loop. Concretely: `NSApplication.shared` +
`setActivationPolicy(.accessory)` (no Dock icon/menu bar — a background
helper, never something the user switches to) + an `NSApplicationDelegate`
+ `app.run()` in place of `RunLoop.main.run()`. See the file's own header
comment for the full design rationale (draggability, position persistence,
fullscreen-Space visibility, the badge icon, and the "waiting for
transcript" placeholder) — it's worth reading in full before touching this
file, since none of those mechanisms are shared with any other file in this
package.

**Protocol** — the first helper in this package that reads commands
INBOUND (every other one only ever writes outbound), one NDJSON object per
line, same convention just reversed:

```
Node -> Swift (stdin):
  {"command":"transcript_append","speaker":"you"|"other","text":"..."}
  {"command":"audio_level","speaker":"you"|"other","level":<number 0.0-1.0>}
  {"command":"hide"}
Swift -> Node (stdout):
  {"event":"ready"}                  — window created and shown
  {"event":"end_requested"}          — the popover's "End" button was clicked
  {"event":"error","message":"..."}  — non-fatal problem worth logging
```

`audio_level` drives a small two-row per-speaker level meter (smoothed with
an exponential moving average) shown at the top of the popover, above the
transcript text — it updates far more often (~100-200ms) than
`transcript_append` (~8s STT windows), giving visible proof capture is
working well before the placeholder clears or any transcript text exists.

One process per capture — `argv[1]` is the clean source label (e.g.
`"zoom"`), `hide`/stdin-EOF/SIGTERM all tear it down. The "End" button is a
safety net for when the real `call_ended` signal never fires (see "Fix —
per-process detection" above for why a safety net is still worth having on
top of that fix): clicking it only emits `end_requested` and keeps
running — the daemon decides when capture has actually finished and sends
`hide` once it has, so the badge disappears in sync with capture actually
stopping, not the instant the button is clicked. `CaptureIndicator`
(`src/indicator.ts`) is the Node wrapper, structurally satisfying
`daemon.ts`'s `CallCaptureIndicatorPort` the same import-direction-clean way
`detector.ts`/`notification.ts` satisfy their own ports.

**Building:**

```sh
pnpm --filter @ethosagent/platform-callcapture run build:native
```

Added to the existing `build:native` script. Needs only `AppKit` +
`Foundation` — no CoreAudio/AVFoundation, unlike the audio-capture helpers.

**Manual verification performed:** compiled with `swiftc` and launched for
real (this package's dev machine has a live Aqua session). Confirmed via
`CGWindowListCopyWindowInfo` (filtered to the process's own PID) that
launching the binary creates exactly two real on-screen windows at the
expected 48×48 / 300×220 sizes and expected bottom-right-of-screen position;
exercised `transcript_append`/an unrecognized command/`hide` over a held-open
stdin pipe and confirmed the process exits cleanly (code 0, zero windows
left behind) after `hide`. **Not confirmed:** an actual pixel-level
screenshot of the rendered badge/icon/hover popover — `screencapture` and
`CGWindowListCreateImage`-style capture both require Screen Recording /
Accessibility permission this environment's shell doesn't have, and there
was no human present to look at the screen directly. The icon-path
resolution and the "waiting for transcript" placeholder text were verified
by inspecting the resolved file path and reading the source logic, not by
looking at rendered pixels — treat the exact visual result (icon crop,
text layout, colors) as unconfirmed until a human checks it live.
