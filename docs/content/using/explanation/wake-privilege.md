---
title: "Why can't a voice in the room reach a privileged personality?"
description: "A wake surface has no caller identity, so Ethos excludes personalities whose toolset can reach a tool the approval layer would stop and ask about."
kind: explanation
audience: user
slug: wake-privilege
updated: 2026-08-14
---

## Context

Put a microphone in a room and you have added an entry point with no login screen. Every other surface Ethos exposes knows something about who is talking: a Telegram chat has an account behind it, the web UI has a token in a cookie, the CLI has a shell someone already owns. A [wake satellite](../../getting-started/glossary.md#wake-satellite) (a separate process that owns a microphone and streams speech to the Ethos server) knows only that a sound happened nearby.

So the question a wake route has to answer is not "is this the owner?" — nothing on this path can tell. It is: *given that anyone within earshot can trigger this, which agents may it reach?*

Ethos answers by narrowing the default surface. Every unprivileged [personality](../../getting-started/glossary.md#personality) (a directory of files that decides the agent's tools, memory, and model) answers to its own name with no configuration at all — a greeting in front of it is optional, so `researcher` and `hey researcher` are the same address. A **privileged** personality gets no such default, and a [wake route](../../getting-started/glossary.md#wake-route) (one `phrase → personality` mapping the server owns) pointed at one is refused unless it opts in out loud:

```
"engineer" is privileged; set voice.wake.routes.kitchen.privileged: true to reach it by voice.
```

## Discussion

### Privilege is derived from the approval layer, not invented for voice

There was no pre-existing notion of a "privileged personality" in Ethos, and inventing a second opinion about what counts as dangerous would have been the wrong move — two lists of consequential tools drift, and the one that drifts is always the one nobody is testing.

So `isPrivilegedPersonality` in `apps/web-api/src/voice/wake-privilege.ts` lifts the lists the approval layer already uses: `SMART_MODE_CONSEQUENTIAL_TOOLS` (`terminal`, `write_file`, `patch_file`, `process_start`) and `APPROVAL_SURFACE_ALWAYS_ASK` (`skills_pending_approve`, `skills_pending_reject`, `call`), both from `packages/wiring/src/danger-predicate.ts`. A personality is privileged when its toolset can reach any of them.

The granularity is the interesting part. Those lists are per-*call*: they decide whether one tool invocation needs a human to approve it. The wake surface needs a per-*personality* answer, before any call exists — because the decision it is making is whether a stranger's voice may start a turn at all. Lifting the list rather than forking it means the wake surface tightens automatically when the approval layer decides something new is consequential.

### An absent toolset is privileged

A personality with no `toolset.yaml` gets every registered tool, which includes every consequential one. `isPrivilegedPersonality` returns `true` for it.

That is fail-closed on purpose, and the asymmetry of the costs is the whole argument. A false positive costs one config line the operator writes deliberately. A false negative costs a stranger at the window running `terminal`.

### Exclusion, not a warning or a confirmation

Ethos already has a spoken-confirmation gate for high-impact actions, and it still applies to a wake turn. It is not, on its own, enough to let any personality be woken.

A confirmation gate answers "should this action proceed?" to *whoever is speaking*. On a room microphone, the party who would confirm is the same unauthenticated voice that asked. The gate is real protection when there is a known party on the other end; on a wake surface it degrades into asking the caller whether they meant it.

The route-level flag makes the operator the party who decides, once, at configuration time, when they can see the whole table — rather than the person standing in the room deciding at trigger time.

### Refused, never downgraded

When a wake resolves to a privileged personality without an opt-in, the server sends an error frame and stops. It does not fall back to a safer personality.

Silently answering as somebody else would be worse than not answering: the speaker gets a reply, believes they reached the engineer, and acts on what a different agent said. A room has no visible personality bar to correct that impression. The same rule governs a route naming a personality that has been deleted or renamed — refused, not defaulted.

### The gate is server-side, so the satellite has nothing to be trusted about

A satellite declares in its `register` frame whether it matches wake phrases itself. `ethos listen` declares `false`: it hears sound, not words, and its `wake` frame names no phrase and no personality. The server transcribes, matches the transcript against its own effective table, and runs the turn on the personality the **match** names.

A host with an acoustic keyword spotter — the desktop satellite — declares `true`, and its `wake` frame does name a route. The server still resolves that route again, against its own table and the hot-reloaded personality registry, and refuses one that names a deleted, renamed, or privileged personality.

Both paths run the same authorization function, deliberately: two copies of an access-control rule is one copy that eventually says yes where the other says no. And in both directions the client's claim is at most a pointer, never a grant. A satellite's table can be one push stale, and a satellite is software installed on someone else's machine — it can be old, patched, or lying. Access control decided on the client is access control an attacker configures.

A satellite that predates the `phraseMatch` field lands on `false` and is gated, which is the conservative half. The field defaults that way for exactly this reason: a node that does not say it matches phrases is not trusted to have matched one.

### The addressing window is scoped to a personality, not to the surface

Once a phrase reaches a personality, follow-ups within `voice.wake.idleTimeout` reach that same personality with no phrase — otherwise a conversation would mean re-addressing every sentence, which nobody does with a person.

That window inherits the decision the phrase made; it never widens it. It belongs to one personality, so it can only ever continue an exchange that was already authorized. A privileged personality that was refused opens no window, and a phrase naming a different agent switches the window rather than sliding into it — including at a microphone pinned with `ethos listen --route`, where another agent's phrase is discarded rather than handed to the pinned one.

What the window does change is the blast radius of a single successful wake: for its duration, anyone in earshot can continue the conversation without saying anything that sounds like an address. Shorten `voice.wake.idleTimeout` where that matters.

## Trade-offs

**The useful personalities are the excluded ones.** The agent you most want to reach hands-free from the kitchen — the one that can run a command, edit a file, place a call — is exactly the one the default surface refuses. Every ambient deployment worth having will therefore write at least one `privileged: true` line. The flag is not a wall; it is a place where the decision is recorded and reviewable.

**Once opted in, there is no second check.** `privileged: true` makes that personality reachable by *any* voice in earshot, including a voice on a television — and, for the length of the idle window, by any voice that simply keeps talking after someone else woke it. Speaker verification is an explicit follow-up and is not built. Until it lands, route-level opt-in is the wake surface's entire access control, and the wake phrase is not a secret.

**Gating is not the same as not listening.** On a host that matches server-side, refusing to run a turn happens *after* speech-to-text, so an utterance addressed to nobody has still been transcribed on the server. The gate protects the agent, not the microphone. A deployment that needs the audio never to leave unrecognized needs an acoustic engine, which today means `sherpa` and its models.

**Privilege is toolset-shaped, so it can surprise you.** Adding `write_file` to a personality's toolset silently withdraws its bare-name default, and the symptom is a phrase that stops working rather than an error at the moment the toolset changed. The Settings → Voice route table shows the effective set, which is where to look when a personality stops answering. On a satellite the same absence arrives as `ethos listen --route auto:<id>` refusing an id the pushed table does not hold; that refusal restates this rule, because a table listing only what is present reads like a bug.

**A narrow toolset is not a safe one.** The lists cover irreversible *local* actions. A personality with only `web_search` and `send_message` is unprivileged by this definition and can still be told to message someone on the operator's behalf. The check bounds the blast radius; it does not make an ambient agent harmless.

## See also

- [Run a wake satellite](../how-to/run-a-wake-satellite.md) — configuring routes, including the `privileged` opt-in
- [`config.yaml` reference: `voice.wake.*`](../reference/config-yaml.md#voice-wake) — the `privileged` and `enabled` route fields
- [Set up approval gates](../how-to/set-up-approval-gates.md) — the per-call approval layer these lists come from
- [Why is a personality a governed contract?](../../building/explanation/personality-governance.md) — why routing is a deployment fact and never a personality field
- [Threat model](../../security/threat-model.md) — the trust boundaries the rest of the system draws
