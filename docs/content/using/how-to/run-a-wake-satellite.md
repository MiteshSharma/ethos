---
title: "Run a wake satellite"
description: "Run ethos listen on a spare machine so speech captured there is answered by one personality, and edit the phrase-to-personality table from Settings."
kind: how-to
audience: user
slug: run-a-wake-satellite
time: "20 min"
updated: 2026-08-14
---

## Task

Put a microphone in another room — a Pi, a spare laptop, the machine under the desk — and have what you say there answered by a named [personality](../../getting-started/glossary.md#personality) (a directory of files that decides the agent's tools, memory, and model), with its toolset and memory scope intact.

## Result

- A [wake satellite](../../getting-started/glossary.md#wake-satellite) (a separate process that owns a microphone and streams speech to the Ethos server) connects to `ethos serve` and appears as a live row under **Settings → Voice → Wake routes**.
- Speech captured on that machine runs a turn as the personality named by its [wake route](../../getting-started/glossary.md#wake-route) (one `phrase → personality` mapping the server owns).
- Each personality keeps its own conversation on that node, so re-waking one resumes where it left off and waking another does not continue somebody else's thread.
- Editing the route table in Settings reaches connected microphones without a restart.

## What this does not do yet

Read this before you buy hardware.

- **`ethos listen` is push-to-talk, not acoustic wake.** Nothing on this host matches a phrase against sound. Speech detected on the pipe opens an utterance and sends it as the route you named with `--route`. You are the wake word; closing the pipe is how you stop talking.
- **Acoustic wake needs a part that is not installed.** The `sherpa` engine is an optional native peer (`sherpa-onnx-node`, a per-architecture binary of roughly 33 MB) plus four model files. Its adapter is written against sherpa's documented keyword-spotter surface and has never been run against a real binary in this repository.
- **The desktop app cannot listen.** The Electron main process ships no microphone binding, so its satellite host fails its own `capture-device` probe, reports `degraded`, and declines to start. That refusal is deliberate: a green dot over a microphone that produces nothing is worse than no dot.
- **Wake quality is unmeasured.** There are no false-accept or false-reject numbers for any engine here, because no test corpus exists.
- **A satellite cannot speak.** `ethos listen` has no output device, so it registers `playback: false` and the server skips synthesis for that node. The answer comes back as text and the daemon prints it (`‹ engineer: …`) under the transcript of what you said. Nothing is spoken in that room.

## Prereqs

- `ethos serve` running and reachable from the satellite machine. The lane is hosted by the web API at `GET /satellite/ws`, not by `ethos gateway`.
- A speech-to-text provider configured, because the server transcribes what the satellite sends. Any route in [Local voice](./local-voice.md) works.
- `ffmpeg` (macOS) or `arecord` (Linux) on the satellite machine. `ffmpeg` is already documented for [voice notes on channels](./voice-notes-on-channels.md); here it doubles as the capture source.
- No new runtime dependency. The default `transcript` engine loads no native binding and no model file.

## 1. Add a wake route

Every unprivileged personality already answers to `hey <name>`, with no configuration, on any satellite that actually matches phrases. `ethos listen` matches nothing, so it needs a configured route to attribute your speech to — this step is required for it.

Open **Settings → Voice → Wake routes**, or write it by hand in `~/.ethos/config.yaml`:

```yaml
voice.wake.routes.kitchen.phrase: hey engineer
voice.wake.routes.kitchen.personality: engineer
```

The route id (`kitchen`) is yours to choose and must match `[A-Za-z0-9_-]+`. A route missing either `phrase` or `personality` is dropped on read rather than half-built.

A route saved in Settings is pushed to every connected satellite immediately. A route you hand-edit applies on the next satellite reconnect or server restart — nothing watches the file.

## 2. Preflight the satellite machine

Run the doctor before you run the daemon. It asks the engine to load what it would load and the device to enumerate what it would open, so nothing is reported available on a guess.

```bash
ethos listen doctor
```

```
ethos listen doctor  wake satellite preflight

  ✓  engine:transcript      no native bindings and no model files — matches wake phrases against STT output
  ⚠  models                 not required by the 'transcript' engine — model directory missing — ~/.ethos/models/wake
  ✓  microphone             1 input device(s): raw s16le mono PCM on stdin @ 16000 Hz
  ⚠  gateway                http://127.0.0.1:3000/healthz answered 503
  ✓  node id                pi-kitchen-f089dce2 (~/.ethos/listen-node-id)
  ✓  satellite url          ws://127.0.0.1:3000/satellite/ws
  ✓  route                  kitchen: "hey engineer" → engineer

⚠ Nothing is broken on this host, but it cannot listen right now.
```

Exit codes are `0` clean, `1` for a host that will never hear you (no config, no usable engine, missing models for a `sherpa` host), and `2` for something true right now that may not be in a minute — no pipe attached, or the server not started. Add `--json` for one machine-readable object; its `engine.daemonMode` field reads `"push-to-talk"`, so a script cannot infer acoustic wake from the engine name.

If the server is on another machine, point at it:

```bash
ethos listen doctor --url ws://ethos.local:3000
```

A bare origin gets the lane path appended for you.

## 3. Pipe a microphone in

`ethos listen` reads raw signed 16-bit little-endian **mono** PCM at **16 kHz** from stdin. There is no microphone binding, deliberately — a native audio module is a per-architecture binary, and this is the daemon that has to run on the Pi where such a binary is broken.

```bash
# macOS
ffmpeg -f avfoundation -i :0 -ar 16000 -ac 1 -f s16le - | ethos listen --route kitchen
```

```bash
# Linux
arecord -f S16_LE -r 16000 -c 1 -t raw | ethos listen --route kitchen
```

The preflight rows print first, then the two lines that say what this daemon is:

```
Push-to-talk: nothing is acoustically wake-matched here. Every utterance on the pipe is sent as "hey engineer" → engineer (route kitchen).
Listening on raw s16le mono PCM on stdin @ 16000 Hz. Press Ctrl+C to stop; close the pipe to stop talking.
```

Get the sample rate right. Raw PCM carries no header, so piping 44.1 kHz stereo produces garbage that nothing can detect — the flags above are the contract.

Omit `--route` only when exactly one route is enabled. With two or more, the daemon refuses rather than guessing which personality answers.

From a clone, `make listen` prints both pipelines and then runs the daemon, and `make listen-doctor` runs the preflight.

## 4. Watch it from Settings

Open **Settings → Voice → Wake routes**. The connected satellite appears as a row carrying what the node itself reported: its state (`listening`, `muted`, `speaking`, `wake off`, `degraded`), its capabilities, its last wake event, and any failing preflight probe inline. The state is never inferred from "the socket is open" — a microphone that misreports whether it is listening is a privacy defect, not a cosmetic one.

The **Say a phrase** tester in the same panel proves a route before you save it: speak, and the row that would answer lights up in that personality's accent. It uses this browser's microphone and the transcript matcher, so it needs the same speech-to-text provider the server uses.

Mute one node from its row. The daemon persists that choice, so a muted microphone comes back muted after a restart.

The scalar knobs below the table — engine, sensitivity, confirmation frames, edge speech-to-text, idle timeout — are shown read-only. Change them in `config.yaml`; see the [`voice.wake.*` reference](../reference/config-yaml.md#voice-wake).

## 5. Reach a privileged personality

A personality whose toolset can reach a tool the approval layer would stop and ask about gets no `hey <name>` default, and a plain route pointed at it is refused:

```
"engineer" is privileged; set voice.wake.routes.kitchen.privileged: true to reach it by voice.
```

If you accept that anyone within earshot can trigger it, opt in out loud:

```yaml
voice.wake.routes.kitchen.privileged: true
```

Why the default is a refusal rather than a warning is in [Why can't a voice in the room reach a privileged personality?](../explanation/wake-privilege.md).

## Verify

With the server up and the pipe attached, the preflight goes clean — the last three rows and the summary are what to read:

```bash
ethos listen doctor
```

```
  ✓  satellite url          ws://127.0.0.1:3000/satellite/ws
  ✓  route                  kitchen: "hey engineer" → engineer

✓ Preflight clean. Start with ethos listen.
```

That exits `0`: the engine loaded, a device enumerated, the route resolved, and the server answered.

The daemon also writes a heartbeat every 10 seconds:

```bash
cat ~/.ethos/listen-health.json
```

```json
{"pid":41233,"startedAt":"2026-08-14T09:12:04.113Z","updatedAt":"2026-08-14T09:12:34.140Z","adapters":[{"name":"satellite","ok":true},{"name":"capture","ok":true}],"captureState":"listening"}
```

Finally, confirm the personality really answered as itself: ask it for something only its toolset allows. One turn narrates as four lines — what opened, what the server heard, what the personality said, and the re-arm:

```
● speech — utterance u1-mf3k9 open as engineer (route kitchen).
  › you: what is on my calendar
  ‹ engineer: Two meetings, both after lunch.
  ↩ turn complete. Listening again.
```

The `‹` line is the whole answer on this host — there is no loudspeaker to say it — and the name on it is the personality that actually ran, resolved by the server rather than claimed by the satellite. The woken personality arrives with its own tools, memory scope, and model routing; that is the point of routing to a personality rather than to a prompt.

## Troubleshoot

- **`✗ Nothing is piped to stdin — not starting.`** You ran `ethos listen` from a shell with no pipe. Enumerating a device that will never produce a sample is the false-available failure this preflight exists to refuse. Pipe `ffmpeg` or `arecord` in.
- **`✗ No usable wake engine on this host — not starting.`** Every engine probe failed, including the dependency-free one. Read the `engine:` rows above the message.
- **`⚠ degraded engine:sherpa: sherpa-onnx-node is not installed`** — the acoustic engine is unavailable and the daemon continues on push-to-talk. Install the peer on that host, or set `voice.wake.engine: fallback`.
- **`no enabled wake route '<id>'`** — the id after `--route` is not in `voice.wake.routes`, or it is `enabled: false`. The message lists the ids that are configured.
- **`No wake route matches "<phrase>"`** from the server — the satellite's pushed table is stale, or the route was deleted. It refreshes on reconnect.
- **`⚠ playout the server is sending synthesized audio, and this host has no output device`** — the server is an older build: a current one skips synthesis for a `playback: false` node. The audio is discarded. The reply text still prints.
- **`⚠ edge stt`** — `voice.wake.edgeStt` is on, but neither shipped host has an on-device recognizer. Audio *will* be streamed to the server, and the "no audio leaves the machine" guarantee does not hold there.
- **The row says `degraded` after a reply.** The playback watchdog fired: the host never reported playback finishing, so the machine re-armed the microphone without a receipt rather than leaving it parked. The detail on the row names the timeout.

## See also

- [`config.yaml` reference: `voice.wake.*`](../reference/config-yaml.md#voice-wake) — every wake key with its bounds and default
- [CLI reference: `ethos listen`](../reference/cli.md#ethos-listen) — flags, exit codes, and the health file
- [Why can't a voice in the room reach a privileged personality?](../explanation/wake-privilege.md) — what the `privileged` flag is defending
- [Local voice: Kokoro TTS + Whisper large v3 STT](./local-voice.md) — wire the speech-to-text provider this page assumes
- [Send and receive voice notes on a channel](./voice-notes-on-channels.md) — the `/voice` mode that decides whether a wake turn is spoken back
