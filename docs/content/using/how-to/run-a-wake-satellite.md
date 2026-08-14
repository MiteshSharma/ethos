---
title: "Run a wake satellite"
description: "Run ethos listen on a spare machine so saying a personality's name there reaches it, and edit the name-to-personality table from Settings."
kind: how-to
audience: user
slug: run-a-wake-satellite
time: "20 min"
updated: 2026-08-14
---

## Task

Put a microphone in another room — a Pi, a spare laptop, the machine under the desk — say `engineer` into it, and have the named [personality](../../getting-started/glossary.md#personality) (a directory of files that decides the agent's tools, memory, and model) answer with its toolset and memory scope intact.

## Result

- A [wake satellite](../../getting-started/glossary.md#wake-satellite) (a separate process that owns a microphone and streams speech to the Ethos server) connects to `ethos serve` and appears as a live row under **Settings → Voice → Wake routes**.
- An utterance that **opens with a personality's name** runs a turn as that personality. A greeting in front of the name (`hey`, `hi`, `hello`, `ok`, `okay`, `yo`, `hey there`) is optional, and the whole address is stripped — `engineer, did CI pass` and `hey engineer, did CI pass` both reach the agent as `did CI pass`.
- Follow-ups within `voice.wake.idleTimeout` continue with the same personality, with no name — you do not re-address somebody you are already talking to.
- Everything else is transcribed and discarded: no turn, no model call, no reply.
- Each personality keeps its own conversation on that node, so re-waking one resumes where it left off and waking another does not continue somebody else's thread.
- Editing the route table in Settings reaches connected microphones without a restart.

## The model, in one paragraph

The microphone is **open**, and the server decides who was addressed. Every utterance the satellite captures is sent up and transcribed. The server matches the transcript against the effective route table: a match picks the personality and runs the turn, a follow-up inside the idle window continues with that same personality, and anything else is dropped without reaching a model. `ethos listen` matches nothing itself — it registers `phraseMatch: false` and the gate runs where the transcript already is.

That has a privacy consequence worth stating plainly: **the room is transcribed.** Not every utterance reaches an agent, but every utterance reaches speech-to-text. If that is not acceptable, do not run this host in that room — an acoustic gate that decides before recognition is the `sherpa` engine, and it is not installed (see below).

## What this does not do yet

Read this before you buy hardware.

- **`ethos listen` does not gate on sound.** Nothing on this host compares audio to a phrase; the phrase gate is server-side and runs on the transcript. The room is transcribed either way.
- **Acoustic wake needs a part that is not installed.** The `sherpa` engine is an optional native peer (`sherpa-onnx-node`, a per-architecture binary of roughly 33 MB) plus four model files. Its adapter is written against sherpa's documented keyword-spotter surface and has never been run against a real binary in this repository.
- **The desktop app cannot listen.** The Electron main process ships no microphone binding, so its satellite host fails its own `capture-device` probe, reports `degraded`, and declines to start. That refusal is deliberate: a green dot over a microphone that produces nothing is worse than no dot.
- **Wake quality is unmeasured.** There are no false-accept or false-reject numbers for any engine here, because no test corpus exists.
- **A satellite cannot speak.** `ethos listen` has no output device, so it registers `playback: false` and the server skips synthesis for that node. The answer comes back as text and the daemon prints it (`‹ engineer: …`) under the transcript of what you said. Nothing is spoken in that room.

## Prereqs

- `ethos serve` running and reachable from the satellite machine. The lane is hosted by the web API at `GET /satellite/ws`, not by `ethos gateway`.
- A speech-to-text provider configured, because the server transcribes what the satellite sends. Any route in [Local voice](./local-voice.md) works.
- `ffmpeg` (macOS) or `arecord` (Linux) on the satellite machine. `ffmpeg` is already documented for [voice notes on channels](./voice-notes-on-channels.md); here it doubles as the capture source.
- No new runtime dependency. The daemon's open-mic capture and the server's phrase matching both load no native binding and no model file.

## 1. Add a wake route

Every unprivileged personality already answers to its own name, with no configuration: the server synthesizes an `auto:<personality-id>` route for each one, pushes the merged table to every satellite on connect, and matches transcripts against it. A deployment that has configured nothing still answers to every personality by name. Write your own route when you want a chosen phrase, a stable id, or a personality the defaults exclude — the rest of this page uses one.

Open **Settings → Voice → Wake routes**, or write it by hand in `~/.ethos/config.yaml`:

```yaml
voice.wake.routes.kitchen.phrase: chief
voice.wake.routes.kitchen.personality: engineer
```

The route id (`kitchen`) is yours to choose and must match `[A-Za-z0-9_-]+`. A route missing either `phrase` or `personality` is dropped on read rather than half-built. Write the phrase without a greeting — `chief`, not `hey chief`. The matcher accepts one either way, so the two spellings are the same trigger, and the shorter one is what the table shows people to say.

A route saved in Settings is pushed to every connected satellite immediately. A route you hand-edit applies on the next satellite reconnect or server restart — nothing watches the file.

## 2. Preflight the satellite machine

Run the doctor before you run the daemon. It asks the engine to load what it would load and the device to enumerate what it would open, so nothing is reported available on a guess. The `satellite-lane` row sends a real WebSocket upgrade to `/satellite/ws` with no auth cookie, so a `401` on it means the lane is mounted and refused the probe — which is the answer it is looking for.

```bash
ethos listen doctor
```

```
ethos listen doctor  wake satellite preflight

  ✓  engine:transcript      no native bindings and no model files — matches wake phrases against STT output
  ⚠  models                 not required by the 'transcript' engine — model directory missing — ~/.ethos/models/wake
  ✓  microphone             1 input device(s): raw s16le mono PCM on stdin @ 16000 Hz
  ⚠  satellite-lane         ws://127.0.0.1:3000/satellite/ws: connection refused (ECONNREFUSED) — nothing is listening there, so the server is not running. Start it with `ethos serve`.
  ✓  node id                pi-kitchen-f089dce2 (~/.ethos/listen-node-id)
  ✓  satellite url          ws://127.0.0.1:3000/satellite/ws
  –  route                  configured here: kitchen ("chief" → engineer). The effective table is the server's: it adds a bare-NAME route (auto:<personalityId>) for every unprivileged personality, pushes the merged table on connect, and MATCHES transcripts against it — so what this host can be addressed by is only knowable once it has connected. Without --route, every phrase in that table can address this host.

⚠ Nothing is broken on this host, but it cannot listen right now.
```

The `route` row is a dash rather than a verdict. This command never connects, so it has none to give: it reports what your own `config.yaml` contributes and names the server as the authority for the rest.

Exit codes are `0` clean, `1` for a host that will never hear you (no config, no usable engine, missing models for a `sherpa` host), and `2` for something true right now that may not be in a minute — no pipe attached, or the server not started. Add `--json` for one machine-readable object; its `engine.daemonMode` reads `"open-mic"` and `engine.phraseMatch` reads `false`, so a script cannot infer acoustic wake from the engine name.

If the server is on another machine, point at it:

```bash
ethos listen doctor --url ws://ethos.local:3000
```

```
  ✓  satellite url          ws://ethos.local:3000/satellite/ws
```

A bare origin gets the lane path appended for you.

## 3. Pipe a microphone in

`ethos listen` reads raw signed 16-bit little-endian **mono** PCM at **16 kHz** from stdin. There is no microphone binding, deliberately — a native audio module is a per-architecture binary, and this is the daemon that has to run on the Pi where such a binary is broken.

```bash
# macOS
ffmpeg -nostats -loglevel error -f avfoundation -i :0 -ar 16000 -ac 1 -f s16le - | ethos listen
```

```bash
# Linux
arecord -q -f S16_LE -r 16000 -c 1 -t raw | ethos listen
```

Keep the quiet flags. The capture process and the daemon share one terminal, and ffmpeg's progress meter is a carriage-returned line that overwrites the daemon's output mid-word — `› you: hello7.9kbits/s speed= 1x`. `-nostats -loglevel error` drops the banner and the meter; a real failure, such as a device index that does not exist, still prints. `arecord -q` does the same for its one banner line.

The preflight rows print first, then the line that names the lane it is dialling for its route table, then the three that say what this daemon is and what can address it:

```
Connecting to ws://127.0.0.1:3000/satellite/ws for the wake route table...
Open mic: EVERYTHING heard here is transcribed by the server. An utterance reaches an agent only when it OPENS with a personality's NAME — that name picks the personality, and a greeting in front of it is optional — and follow-ups within 30s continue with the same one. Anything else is heard and discarded.
Addressable here — say one of these: "chief" → engineer, "researcher". A greeting in front of it ("hey …") is optional.
Listening on raw s16le mono PCM on stdin @ 16000 Hz. Press Ctrl+C to stop; close the pipe to stop talking.
```

Get the sample rate right. Raw PCM carries no header, so piping 44.1 kHz stereo produces garbage that nothing can detect — the flags above are the contract.

From a clone, `make listen` prints both pipelines and then runs the daemon, and `make listen-doctor` runs the preflight.

### Dedicate one microphone to one agent

`--route <id>` **pins** the host: only that route may address it. The garage mic answers `mechanic` and ignores `engineer`, even though both are live in the house's table.

```bash
arecord -q -f S16_LE -r 16000 -c 1 -t raw | ethos listen --route kitchen
```

```
Connecting to ws://127.0.0.1:3000/satellite/ws for the wake route table (pinning to route kitchen)...
Pinned by --route: only "chief" → engineer (route kitchen, from voice.wake.routes) can address this microphone. Other phrases are heard and discarded.
```

Pinning narrows the wake surface; it does not exempt the host from needing an address. The pinned phrase is still required, and another agent's name is discarded rather than treated as a follow-up — so `researcher` at a mic pinned to the engineer never lands in the researcher's conversation. `--route auto:<personality-id>` pins to a synthesized route with no config at all. Without the flag, every enabled route can address this host, which is the usual choice.

## 4. Watch it from Settings

Open **Settings → Voice → Wake routes**. The connected satellite appears as a row carrying what the node itself reported: its state (`listening`, `muted`, `speaking`, `wake off`, `degraded`), its capabilities, its last wake event, and any failing preflight probe inline. The state is never inferred from "the socket is open" — a microphone that misreports whether it is listening is a privacy defect, not a cosmetic one.

Two things on the row come from the gate. The capability label ends in `server matches` for `ethos listen` and `matches phrases` for a host with an acoustic spotter — which end matched the phrase is the same privacy fact as which end transcribed. And while a conversation is open the row says `follow-ups reach <personality> · 24s left`, so an unaddressed sentence that reached an agent is explainable rather than surprising.

The **Say a phrase** tester in the same panel proves a route before you save it: speak, and the row that would answer lights up in that personality's accent. It uses this browser's microphone and the transcript matcher, so it needs the same speech-to-text provider the server uses.

Mute one node from its row. The daemon persists that choice, so a muted microphone comes back muted after a restart.

The scalar knobs below the table — engine, sensitivity, confirmation frames, edge speech-to-text, idle timeout — are shown read-only. Change them in `config.yaml`; see the [`voice.wake.*` reference](../reference/config-yaml.md#voice-wake).

## 5. Reach a privileged personality

A personality whose toolset can reach a tool the approval layer would stop and ask about gets no bare-name default, and a plain route pointed at it is refused:

```
"engineer" is privileged; set voice.wake.routes.kitchen.privileged: true to reach it by voice.
```

If you accept that anyone within earshot can trigger it, opt in out loud:

```yaml
voice.wake.routes.kitchen.privileged: true
```

Why the default is a refusal rather than a warning is in [Why can't a voice in the room reach a privileged personality?](../explanation/wake-privilege.md).

## Verify

With the server up and the pipe attached, the preflight goes clean — the lane row, the address it would dial, and the route row are what to read:

```bash
ethos listen doctor
```

```
  ✓  satellite-lane         ws://127.0.0.1:3000/satellite/ws is mounted — answered 401 to a probe sent with no auth cookie, which is the expected refusal
  ✓  satellite url          ws://127.0.0.1:3000/satellite/ws
  –  route                  configured here: kitchen ("chief" → engineer). The effective table is the server's: it adds a bare-NAME route (auto:<personalityId>) for every unprivileged personality, pushes the merged table on connect, and MATCHES transcripts against it — so what this host can be addressed by is only knowable once it has connected. Without --route, every phrase in that table can address this host.

✓ Preflight clean. Start with ethos listen.
```

That exits `0`: the engine loaded, a device enumerated, and the satellite lane answered. Routing is the one thing it does not settle — the server matches each transcript against the table it holds at that moment, and validates a `--route` pin when `ethos listen` connects.

The daemon also writes a heartbeat every 10 seconds:

```bash
cat ~/.ethos/listen-health.json
```

```json
{"pid":41233,"startedAt":"2026-08-14T09:12:04.113Z","updatedAt":"2026-08-14T09:12:34.140Z","adapters":[{"name":"satellite","ok":true},{"name":"capture","ok":true}],"captureState":"listening"}
```

Finally, confirm the personality really answered as itself: ask it for something only its toolset allows. One addressed turn narrates as four lines — what opened, what the server heard, what the personality said, and the re-arm:

```
● speech — utterance u1-mst43nas open
  › you: researcher, what is on my calendar
  ‹ researcher: Two meetings, both after lunch.
  ↩ turn complete. Listening again.
```

The `●` line names no personality, because none has been chosen yet: the words decide, and nobody has heard them. The `‹` line is the whole answer on this host — there is no loudspeaker to say it — and the name on it is the personality the server matched. The woken personality arrives with its own tools, memory scope, and model routing; that is the point of routing to a personality rather than to a prompt.

Now say something that names nobody. The room's ordinary traffic looks like this:

```
  › you: could you pass the salt
  ↩ not addressed to anyone — no agent was called. Open with a personality's name to reach one. Listening again.
```

Heard, transcribed, discarded. No turn ran and no tokens were spent.

Then prove the conversation continues without the name. Say `researcher, what can you do`, and within `voice.wake.idleTimeout` say `tell me more` — the second reaches the researcher too, and the `‹` line names it. Wait out the window and say `tell me more` again: that one is not addressed to anyone. The window is per-connection and dies when the daemon restarts; the conversation itself does not, so re-waking the researcher after a reboot resumes the same history.

## Troubleshoot

- **`✗ Nothing is piped to stdin — not starting.`** You ran `ethos listen` from a shell with no pipe. Enumerating a device that will never produce a sample is the false-available failure this preflight exists to refuse. Pipe `ffmpeg` or `arecord` in.
- **`✗ No usable wake engine on this host — not starting.`** Every engine probe failed, including the dependency-free one. Read the `engine:` rows above the message.
- **`⚠ degraded engine:sherpa: sherpa-onnx-node is not installed`** — the acoustic engine is unavailable and the daemon continues as an open mic. Install the peer on that host, or set `voice.wake.engine: fallback`.
- **`✗ the server's wake route table has no enabled route '<id>'`** — the id after `--route` is not in the table the server pushed, or it is disabled. The message lists every id that was pushed, synthesized `auto:<personality-id>` ones included, then states the rule for the ones it did not.
- **The personality you wanted is not in that list at all.** It is privileged, so it gets no `auto:<personality-id>` default — its toolset can reach a tool the approval layer would stop and ask about, and a personality with no `toolset.yaml` gets every tool and counts too. Nothing is broken; give it a route and opt it in, as in *Reach a privileged personality* above. The satellite is never told which personalities were withheld, so the message states the rule rather than naming names.
- **`⚠ routes the server pushed an EMPTY wake route table`** — same cause, every personality. Every unprivileged one would have been synthesized into that table under its own name, so an empty table means this deployment has none. The daemon keeps running: a Settings save reaches it without a restart. Opt a personality in rather than widening a toolset to get a default back.
- **Every utterance says `not addressed to anyone`.** The transcript is not opening with a phrase the server holds. Check what the `› you:` line actually says — speech-to-text may be hearing `engine ear` — then raise `voice.wake.sensitivity`, or add a route with the phrase as it is being transcribed. Do not add a route for the greeting: `hey`, `hi`, `hello`, `ok`, `okay`, `yo` and `hey there` are already stripped before matching. The name must be at the **head** of the utterance: "so I said hey engineer to nobody" is talking *about* the agent, not to it.
- **A sentence you did not address reached an agent anyway.** The idle window was still open from the previous turn, which is the intended behaviour — the row in Settings shows `follow-ups reach <personality>` while it is. Shorten `voice.wake.idleTimeout` if the room talks past the agent often.
- **`No wake route matches "<phrase>"`** from the server — only a host that matches phrases itself (the desktop satellite) can produce this: its pushed table is stale, or the route was deleted. It refreshes on reconnect.
- **`⚠ playout the server is sending synthesized audio, and this host has no output device`** — the server is an older build: a current one skips synthesis for a `playback: false` node. The audio is discarded. The reply text still prints.
- **`⚠ edge stt`** — `voice.wake.edgeStt` is on, but neither shipped host has an on-device recognizer. Audio *will* be streamed to the server, and the "no audio leaves the machine" guarantee does not hold there.
- **`● speech` prints and nothing follows it.** The utterance held less than 400 ms of speech, so the satellite discarded it locally instead of sending room noise to speech-to-text. No turn ran, and the microphone re-armed immediately. A pipe that does this constantly is a microphone with too much gain.
- **An empty `› you:` line, then the re-arm.** The audio reached the server and the speech-to-text provider heard nothing in it. That is a report, not a failure — no turn ran, and nothing needs repeating.
- **The row says `degraded` after a reply.** The playback watchdog fired: the host never reported playback finishing, so the machine re-armed the microphone without a receipt rather than leaving it parked. The detail on the row names the timeout.

## See also

- [`config.yaml` reference: `voice.wake.*`](../reference/config-yaml.md#voice-wake) — every wake key with its bounds and default
- [CLI reference: `ethos listen`](../reference/cli.md#ethos-listen) — flags, exit codes, and the health file
- [Why can't a voice in the room reach a privileged personality?](../explanation/wake-privilege.md) — what the `privileged` flag is defending
- [Local voice: Kokoro TTS + Whisper large v3 STT](./local-voice.md) — wire the speech-to-text provider this page assumes
- [Send and receive voice notes on a channel](./voice-notes-on-channels.md) — the `/voice` mode that decides whether a wake turn is spoken back
