---
title: "Why does AgentCard need a drift gate?"
description: "AgentCard is signed and peer-anchored — D14 puts it under ARCHITECTURE.md §VII with a mechanical drift gate against silent field changes."
kind: explanation
audience: developer
slug: agent-card-governance
updated: 2026-08-21
---

## Context

An A2A peer does not re-verify your identity on every message. It verifies
once — a human compares a fingerprint out of band — and trusts that anchor
from then on. `AgentCard` (`packages/types/src/a2a.ts`) is the object that
anchor points at. A silent change to its field shape is not a routine
interface edit; it is a break in every peering built on top of it, and
nothing enforced that until this amendment.

`AgentCard` is `{ id, name, description, protocolVersion, skills, endpoints,
publicKey, keyFingerprint, signatureAlg, signature, did }` — produced by
`A2aIdentityProvider.getIdentity()` in `extensions/personalities/src/
a2a-identity.ts`, and signed with the personality's Ed25519 key over a
deterministic serialization of every field except `signature`. A peer that
adds you (`ethos a2a peer add`) fetches this object, verifies the signature,
and — the load-bearing step — checks the card's `keyFingerprint` against a
value a human copied from a separate channel. From that point on,
`StorageA2aPeerStore` persists the verified card verbatim in
`~/.ethos/a2a/peers.json`, and every audit receipt that references the
peering points back at it.

That is the shape of a [frozen schema](personality-governance.md) as
`ARCHITECTURE.md` §VII defines the term: a contract whose surface is
governed beyond ordinary type changes, because something outside the
codebase — here, an out-of-band human verification and a store full of
already-anchored cards — depends on the shape staying put. Until this
amendment, `AgentCard` was not on that roster. `rg 'a2a' packages/types/src/
__tests__/` returned nothing: there was no mechanical gate, only a
comment in the plan saying not to touch the file. A convention a reviewer
has to remember is not the same thing as a convention a test enforces.

## Discussion

### What the amendment actually changes

Nothing about the type. `packages/types/src/a2a.ts` is byte-for-byte what
it was before D14 — this amendment is pure governance, layered on top of an
unchanged contract. Two things are new:

1. **A roster row.** `AgentCard` now appears in `ARCHITECTURE.md` §VII's
   table, with an owner, a bump trigger, and a drift-gate kind — the same
   four properties every other frozen schema on that roster carries.
2. **A mechanical drift gate.** `.agent-card-field-count` at the repo root
   holds an integer; `packages/types/src/__tests__/agent-card-field-count.
   test.ts` counts `AgentCard`'s top-level fields and its field *names*,
   and fails if either drifts from what the file declares — mirroring
   `.personality-field-count` and `personality-field-count.test.ts`, the
   worked example this page's companion piece describes.

A PR that adds, removes, or renames a field on `AgentCard` now fails a test
before it fails a peer's handshake in production.

### Why this didn't block T0.2

The same review round that locked this amendment (D8) also closed the
question of where A2A's turn-time tool-narrowing data comes from:
`required_tools` is read from a skill's `SKILL.md` at turn time, **not**
added to the signed `AgentSkill` shape nested inside `AgentCard`. The two
decisions point the same direction — the signed card stays exactly what it
is, and anything that needs to change more often lives somewhere else. A
drift gate on a contract nobody is trying to widen is cheap insurance, not
friction.

### Why a §VI *Structural* amendment, not a quieter one

`ARCHITECTURE.md` §VI classifies "adding a new contract type" to the §VII
roster as **Structural** — unanimous maintainer agreement and an RFC, not
the two-maintainer sign-off most existing rows got when they were already
part of the roster. This page, together with the roster row and the
drift-gate test landing in the same commit, is that RFC: the artifact a
later reader checks when they ask "was this actually approved, or did a
test just show up."

## Trade-offs

**A drift gate cannot stop a deliberate, reviewed change** — nor should it.
If `AgentCard` genuinely needs a new field one day, the gate's job is to
force that change through the §VII bump procedure (owner approval, the
drift gate updated in the same commit, a CHANGELOG entry, no-overlap
deprecation) rather than to forbid it outright. The cost this amendment
buys is narrow and specific: an *accidental* or *convenience* field change
— the kind that slips through review because nothing failed — now fails a
test instead.

**The gate does not (and cannot) protect already-anchored peers from a
change that ships anyway.** If a maintainer follows the bump procedure and
ships a field rename, every `peers.json` entry written under the old shape
is now stale data next to new code. That migration cost is real and is not
what this amendment solves — it solves the *silent* version of the same
problem, where nobody notices until a peering breaks in the field.

## See also

- [Why is a personality a governed contract?](personality-governance.md) —
  the worked example this amendment follows: a schema-freeze rule plus a
  mechanical drift gate, applied to `PersonalityConfig` first.
- [Add a skill](../how-to/add-a-skill.md) — `required_tools` and
  `fallback_unknown`, the frontmatter fields D8 reads at A2A turn time
  instead of adding them to the signed card.
