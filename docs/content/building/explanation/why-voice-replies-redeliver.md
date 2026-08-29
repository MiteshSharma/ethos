---
title: "Why does a redelivered voice note re-send the recording?"
description: "A voice reply is a delivery obligation whose payload is a file on disk, so a retry re-sends the original recording rather than synthesizing a new one."
kind: explanation
audience: developer
slug: why-voice-replies-redeliver
updated: 2026-08-14
---

## Context

A spoken reply is the most expensive thing the gateway produces and the easiest thing to lose. It costs a TTS call, an ffmpeg pass, and a file upload — and every one of those can fail after the user has already seen the text reply and stopped watching. "The agent answered, but the voice note never arrived" is a silent failure: nothing is on screen to tell anyone it happened.

The [gateway](../../getting-started/glossary.md#gateway) (the process running every channel adapter) already had an answer for lost *text*: the delivery ledger, an at-least-once store of [delivery obligations](../../getting-started/glossary.md#delivery-obligation) — one row per reply the agent owes a chat — in `@ethosagent/delivery-ledger`. A `pending` row is written before the platform call and flipped to `delivered` only on a confirmed ack; `Gateway.sweepPendingDeliveries()` re-sends whatever is still pending at the next start.

Voice notes were deliberately excluded from that ledger, because a text obligation's payload is a string in a database column and a voice note's payload is megabytes of audio. This page explains what changed, and why the retry re-sends stored bytes rather than calling TTS a second time.

## Discussion

### A second synthesis is a different recording

The obvious implementation is to store the spoken text, and on retry, synthesize it again and send that. It needs no artifact storage, and the ledger row stays a string.

It is also wrong, for three independent reasons:

- **TTS is not deterministic.** Most engines sample. The same input produces a recording with different prosody, different pacing, sometimes a different length.
- **The voice may have moved.** Between the failed send and the sweep — which is typically a process restart — the personality's `voice.tts_voice` may have been edited, the deployment's TTS roster may point somewhere else, or the language-specific voice may now resolve differently.
- **The reply may no longer be what was said.** The obligation's `content` is the *sanitized, possibly truncated* speech text, not the original reply. Re-synthesizing re-derives a recording from a lossy intermediate.

Put together: a user who was owed one answer would receive an answer they can *hear* is not the one that was lost. So the recording, not the text, is the obligation's payload. `redeliverVoiceObligation` in `extensions/gateway/src/index.ts` reads the stored bytes and refuses to fall back to anything else — including sending the spoken text as a plain message, which would deliver the same answer twice, since the written reply already went out under its own obligation.

### What schema v3 added

The ledger row grew three nullable columns rather than a parallel table:

| Column | Meaning |
|---|---|
| `kind` | `'text'` or `'voice'`. A `NULL` is a pre-v3 row, normalized to `'text'` on read. |
| `artifactRef` | Filename of the recording in the gateway's `VoiceArtifactStore`. |
| `mediaFormat` | The container those exact bytes are in. |

Keeping voice in the same table is what makes `sweepPendingDeliveries()` one loop instead of two, and what lets an operator ask "how many replies are still owed?" and get one number. The `deliveries.summary` RPC reports the counts twice — once overall, once restricted to `kind = 'voice'` — because a deployment losing only voice notes is a different diagnosis than one losing everything.

`mediaFormat` is authoritative on retry, not advisory. The artifact holds exactly those bytes, so re-labelling them for a platform's current preference would hand it a mislabelled container. A stored format the adapter no longer accepts — caps changed between the send and the sweep — is refused with `gateway.voice_format_unsupported` rather than guessed at.

### Storing the payload creates a deletion problem

Once the payload is a file, the ledger's lifecycle has to own that file too, or `~/.ethos/voice/artifacts/` grows forever. Three mechanisms, in the order they fire:

1. **Delivered releases.** `deliverVoiceReply` confirms the obligation and deletes the artifact in the same step. In a healthy deployment the directory is empty, because the only recordings that persist are the ones that failed.
2. **Abandoned expires.** `ledger.abandonStale()` gives up on obligations older than [`voice.artifacts.abandonAfterDays`](../../using/reference/config-yaml.md#voice-artifacts) (default 7) and the prune pass deletes their artifacts with them. The ledger filters that call by the deployment's own bot keys, so a shared ledger file never lets one process abandon a live peer's obligation.
3. **The size cap evicts.** [`voice.artifacts.maxTotalMb`](../../using/reference/config-yaml.md#voice-artifacts) (default 512) evicts oldest-first. It is the backstop for what neither of the first two caught — an artifact whose row vanished, or a burst that outran the abandon window.

The prune pass refuses to run without both a ledger and an artifact store. Abandoning rows whose artifacts nothing can delete, or deleting artifacts whose rows nothing abandoned, would leave the two halves permanently out of step — worse than not pruning.

### Why the artifact is written before the send

`voiceArtifacts.put()` runs before `beginDelivery()`, which runs before `sendVoiceNote()`. The ordering is the same "pending before the platform call" discipline the text paths use, extended one step: bytes on disk before the row, row before the send.

A store that is absent or failing returns `null`, and the obligation is still recorded. That obligation can never be repaired — there is nothing to re-send — but it is *visible*, which is the point. An unrepairable loss that shows up in the ledger is strictly better than one that does not.

### Why the artifact is not written atomically

`VoiceArtifactStore.put()` uses `Storage.write`, not `writeAtomic`, which is the opposite of the rule for config and audit logs. A partial artifact is worthless but harmless: the redelivery that reads it fails, the obligation goes back to the pending pool, and the outcome is identical to having no artifact at all. `writeAtomic` would cost a second file write on every voice reply to protect against nothing.

## Trade-offs

**Delivery is at-least-once, so a voice note can arrive twice.** Redelivery deliberately bypasses `shouldSend()` — a warm dedup cache must not swallow something the user never received — and records the dedup key afterwards. A platform that confirmed a send the gateway did not see confirmed will get a second copy.

**Disk is now part of the voice path.** A deployment with a full disk drops artifacts silently (the store reports through `onError` and returns `null`) rather than failing the turn. This is the right trade for a feature that runs after the text reply already landed, but it means artifact loss is a log line, not an error.

**The cap is a byte cap, not a per-conversation one.** Oldest-first eviction under pressure can evict a recent conversation's pending recording if an older backlog is large. There is no per-lane fairness; the assumption is that a backlog large enough to hit 512 MiB is itself the problem to fix.

**Slash-command acks and the background-job wake notice are still not covered.** Extending coverage means extending the obligation contract to messages whose loss is genuinely cheap, and the ledger stays deliberately narrow.

## See also

- [Send and receive voice notes on a channel](../../using/how-to/voice-notes-on-channels.md) — the operator-facing task this mechanism serves
- [`config.yaml` reference: `voice.artifacts.*`](../../using/reference/config-yaml.md#voice-artifacts) — the retention bounds and their defaults
- [Channel capability matrix](../../platforms/capability-matrix.md#voice-caps) — the declared formats a redelivery is matched against
- [Add a channel adapter](../tutorials/add-a-channel-adapter.md) — how a new adapter joins the voice path
