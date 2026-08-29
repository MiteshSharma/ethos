---
title: Peer two Ethos agents over A2A
description: Enable A2A on two Ethos installs, exchange fingerprints, expose a skill, and complete a message/send between them.
kind: how-to
audience: user
slug: peer-two-ethos-agents
time: 30 min
updated: 2026-08-21
---

Ethos agents can call each other directly — one [personality](../../getting-started/glossary.md#personality) asks another to do something and gets a reply back, without a human relaying the message. The wire protocol is A2A: an Ethos-specific JSON-RPC surface that borrows Google A2A's vocabulary (`message/send`, a well-known card path) but is not a conformant implementation of the public spec — a spec client cannot talk to it today. What it does carry, unchanged from the framework's original design, is the trust model: a human anchors each peering by comparing a cryptographic fingerprint out of band, and nothing is reachable until that happens twice — once per direction.

## Task

Peer two Ethos installs so one agent can call a [skill](../../getting-started/glossary.md#skill) on the other and get a reply, with both sides verified and both sides auditable.

## Result

Agent A sends a `message/send` naming a skill on Agent B; Agent B's reply comes back to A; both sides have a signed record of the exchange in their own audit trail.

## Prereqs

- Two working Ethos installs, each already through `ethos setup` with an LLM provider configured. This page runs both on one machine as two isolated instances (`ETHOS_STATE_DIR` points each `ethos` invocation at its own `~/.ethos`-shaped directory) — nothing here requires that; two real machines work the same way, just without the environment variable.
- Two free local ports for `ethos serve` (this page uses `3000` and `3001`).

Open two terminals. In the first:

```bash
export ETHOS_STATE_DIR=/tmp/ethos-a
```

In the second:

```bash
export ETHOS_STATE_DIR=/tmp/ethos-b
```

Every command below is labeled **Terminal A** or **Terminal B**. Run `ethos setup` once in each terminal first if that state directory is new.

## 1. Enable A2A on both agents

**Terminal A** and **Terminal B**:

```bash
ethos a2a enable
```

```
✓ A2A enabled. (Live in the web UI immediately; a running ethos serve/gateway picks it up on next start.)
```

If `webBaseUrl` is not set in `~/.ethos/config.yaml`, `a2a enable` also warns that cards will advertise the wrong port (`:8787`, the identity provider's fallback) instead of wherever you actually run `ethos serve`. Set it explicitly so peers get a reachable URL — there is no CLI setter for this key, so append the line directly:

**Terminal A**:

```bash
echo 'webBaseUrl: http://localhost:3000' >> /tmp/ethos-a/config.yaml
```

**Terminal B**:

```bash
echo 'webBaseUrl: http://localhost:3001' >> /tmp/ethos-b/config.yaml
```

## 2. See the zero-skills warning

A2A is private by default: no built-in personality exposes anything to peers, so a fresh install's card advertises zero skills and every inbound `message/send` is rejected. **Terminal B**:

```bash
ethos a2a status
```

```
✓ a2a           enabled
✓ webBaseUrl    http://localhost:3001
✓ peers         0 configured for engineer
! A2A is enabled but personality "engineer" exposes no skills to peers — every inbound request will be rejected with FORBIDDEN_SCOPE. Set `ethos.exposeToAgents: true` in a skill's SKILL.md frontmatter, under this personality's own skills/ directory, to expose it.
```

(`engineer` here is whatever `~/.ethos/config.yaml`'s `personality:` field resolves to on your install — the warning names it explicitly.) This is expected and correct, not a bug: nothing is reachable until an operator opts a skill in. The same warning prints at `ethos serve` boot when A2A is enabled and the active personality exposes nothing.

## 3. Expose a skill on Agent B

Create a personality on Agent B with its own `skills/` directory — built-in personalities ship with none, and stay that way on purpose. **Terminal B**:

```bash
ethos personality fork engineer echo-bot
mkdir -p /tmp/ethos-b/personalities/echo-bot/skills/echo-status
```

Write the skill. This is the shape of the copyable template that ships at `examples/skills/a2a-expose-template/SKILL.md`, reproduced here with `exposeToAgents` already flipped on:

```bash
cat > /tmp/ethos-b/personalities/echo-bot/skills/echo-status/SKILL.md <<'EOF'
---
name: echo-status
description: Reply with this personality's current status when a trusted A2A peer asks for it.
version: 1.0.0
author: demo
tags: [a2a, template, example]
required_tools: []

ethos:
  exposeToAgents: true
---

# Echo status

Use this skill when an authenticated A2A peer names `echo-status` in
`params.skill` and asks about this agent's current status. Reply with a
short, plain-language status update. Do not reach for any tool — this
skill declares no `required_tools`, so the runtime narrows the turn to an
empty toolset.
EOF
```

Two frontmatter fields matter, and both are read straight from this file at request time, never cached in the signed card:

- `ethos.exposeToAgents: true` — without it the skill exists locally but stays off the trusted-peer card, exactly like every skill on a built-in personality.
- `required_tools: []` — an explicit, intentional grant of *no* tools. A skill with this key **absent** (not merely empty) refuses every inbound turn rather than falling back to the personality's full toolset — that fail-closed behavior is what makes tool-scoping meaningful once a peer is trusted.

## 4. Confirm the warning clears

**Terminal B**:

```bash
ethos a2a status --personality echo-bot
```

```
✓ a2a           enabled
✓ webBaseUrl    http://localhost:3001
✓ peers         0 configured for echo-bot
```

No warning line — `echo-bot`'s trusted-peer card now lists one skill.

## 5. Mint each agent's identity

Minting is automatic on first use: `ethos a2a identity` generates an Ed25519 keypair for the personality if none exists yet, then prints the shareable card. **Terminal B**:

```bash
ethos a2a identity --personality echo-bot
```

```
personality    echo-bot (echo-bot)
fingerprint    3f7a9c1e2b4d6f80
well-known     http://localhost:3001/.well-known/agent-card.json?personality=echo-bot
json-rpc       http://localhost:3001/a2a/echo-bot
auth           http://localhost:3001/a2a-auth/echo-bot
exposed skills echo-status
```

**Terminal A**, on the personality that will make the call (`caller`, forked the same way):

```bash
ethos personality fork engineer caller
ethos a2a identity --personality caller
```

```
personality    caller (caller)
fingerprint    9a1d4e7c0b3f5288
well-known     http://localhost:3000/.well-known/agent-card.json?personality=caller
json-rpc       http://localhost:3000/a2a/caller
auth           http://localhost:3000/a2a-auth/caller
exposed skills none
```

`caller` exposing nothing is fine — it only initiates calls, it never serves an inbound skill. Copy each fingerprint out of band (paste it into the other terminal, a chat message, however you'd hand someone a real secret) — this hex string is the entire trust anchor. The real fingerprints are longer than the examples above; use whatever your terminal printed.

## 6. Add and enable each peer

Peering is bidirectional: A2A checks the allowlist on both the receiving side (is this caller authorized?) and the sending side (am I allowed to call this peer?). Both agents need to add and enable the other.

**Terminal A** — add B, using B's real well-known URL and fingerprint from step 5:

```bash
ethos a2a peer add --personality caller --url http://localhost:3001/.well-known/agent-card.json?personality=echo-bot
```

Run without `--fingerprint` first — this previews the card without writing anything:

```
peer         echo-bot
fingerprint  3f7a9c1e2b4d6f80

Confirm this fingerprint out-of-band, then re-run to add the peer:
  ethos a2a peer add --url http://localhost:3001/.well-known/agent-card.json?personality=echo-bot --fingerprint 3f7a9c1e2b4d6f80
```

Confirm the printed fingerprint matches what B told you in step 5, then re-run with `--fingerprint`:

```bash
ethos a2a peer add --personality caller \
  --url http://localhost:3001/.well-known/agent-card.json?personality=echo-bot \
  --fingerprint 3f7a9c1e2b4d6f80
```

```
✓ echo-bot added (disabled, full access) — run ethos a2a peer enable 3f7a9c1e2b4d6f80 to activate.
```

Every peer is added disabled and full-access (`scope: ['*']`) — a peer's *reach* is bounded by which skills the personality exposes and by T0.2's turn-time tool narrowing, not by the allowlist grant. Enable it:

```bash
ethos a2a peer enable 3f7a9c1e2b4d6f80 --personality caller
```

```
✓ peer 3f7a9c1e2b4d6f80 enabled.
```

**Terminal B** — the same in reverse, adding `caller`'s URL and fingerprint from step 5:

```bash
ethos a2a peer add --personality echo-bot \
  --url http://localhost:3000/.well-known/agent-card.json?personality=caller \
  --fingerprint 9a1d4e7c0b3f5288
ethos a2a peer enable 9a1d4e7c0b3f5288 --personality echo-bot
```

## 7. Give the caller the `a2a_send` tool

The outbound tool, `a2a_send`, is registered only by `ethos serve` and `ethos gateway` — not by `ethos chat` or `ethos -z`. It also has to be on the calling personality's own toolset. **Terminal A**:

```bash
echo '- a2a_send' >> /tmp/ethos-a/personalities/caller/toolset.yaml
```

Personalities are mtime-cached, so this takes effect on the next turn — no restart needed once `ethos serve` is already running.

## 8. Start both servers

**Terminal A**:

```bash
ethos serve --web-port 3000
```

**Terminal B**:

```bash
ethos serve --web-port 3001
```

Leave both running. Open two more terminals for the remaining steps (or background these with `&`).

## 9. Send a message

Mint an API key on Agent A for the chat endpoint (new terminal, same `ETHOS_STATE_DIR=/tmp/ethos-a`):

```bash
ethos api-key create --name "a2a-demo"
```

```
✓ API key created  name: a2a-demo

  sk-ethos-abcdef0123456789...

  prefix: sk-ethos-abcdef
  scopes: chat
```

Ask `caller` to reach out to `echo-bot`:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-ethos-abcdef0123456789..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "caller",
    "messages": [{
      "role": "user",
      "content": "Use a2a_send to ask the peer at http://localhost:3001/.well-known/agent-card.json?personality=echo-bot for its status. Use skill \"echo-status\"."
    }]
  }'
```

The response is an OpenAI-shaped completion whose `choices[0].message.content` is `caller`'s own reply — it summarizes and attributes what `echo-bot` said, since a peer's words arrive tagged as untrusted, not adopted verbatim. Something like:

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "I asked the echo-bot peer for its status. It reports: ... "
    }
  }]
}
```

## 10. Read the audit trail

Both sides logged the exchange as metadata only — never the message body. **Terminal B**:

```bash
ethos audit
```

```
  TIMESTAMP            SEVERITY           CATEGORY / CODE
  ------------------------------------------------------------------------
  2026-08-21 10:14:02  info               a2a.auth a2a-auth
  2026-08-21 10:14:02  info               a2a.rpc message/send
  2026-08-21 10:14:03  info               a2a.task task-state
```

Filter to one surface with `--category`:

```bash
ethos audit --category a2a.rpc
```

`a2a.auth` records the handshake decision (accepted/denied, which fingerprint). `a2a.rpc` records the `message/send` admission decision and which skill was named. `a2a.task` records the terminal task state (`completed`, `failed`, …). None of the three has a field for the message body or the token — the log proves an exchange happened, never what was said.

## Verify

- `ethos a2a status --personality echo-bot` on B prints no warning.
- `ethos a2a peer list --personality caller` on A shows `echo-bot` as `enabled`; the mirror on B shows `caller` as `enabled`.
- The curl in step 9 returns `200` with a completion that references the peer's reply.
- `ethos audit --category a2a.rpc` on B shows a `decision: accepted` entry naming `echo-status`.

## Troubleshoot

| Symptom | Likely cause | Fix |
|---|---|---|
| `FORBIDDEN_SCOPE` (JSON-RPC error `-32003`) | The named skill isn't on the receiving personality's trusted-peer card — either `exposeToAgents` is unset/false, or the skill name doesn't match. | Re-check step 3's frontmatter and re-run `ethos a2a status --personality <id>` to confirm the warning is gone. |
| `fingerprint mismatch` on `peer add` | The `--fingerprint` you typed doesn't match what the URL actually serves — a typo, or `webBaseUrl` pointing at the wrong port so the card came from a different process than you think. | Re-run `peer add` without `--fingerprint` to preview the real value, and confirm `webBaseUrl` matches the port `ethos serve` is actually bound to. |
| `not_available` from `a2a_send` | Either A2A is disabled on the caller's install, or the calling personality has no signing key yet (identity was never minted). | Run `ethos a2a enable` and `ethos a2a identity --personality <id>` on the caller. |
| The model never calls `a2a_send` | `a2a_send` isn't on the personality's `toolset.yaml`, or `ethos chat`/`ethos -z` was used instead of `ethos serve`/`gateway` (the only two surfaces that register the tool). | Confirm step 7, and confirm the request went to a running `ethos serve` process. |
| `a2a_send` call hangs, then fails after ~30s | The peer accepted the connection but never responded — the outbound client times out rather than hanging forever. | Confirm the peer's `ethos serve` is actually up and A2A is enabled there too. |
| `A2A_SKILL_TOOLS_UNDECLARED` | The named skill's SKILL.md has no `required_tools` key at all (not even `[]`) — the runtime fails the turn closed rather than granting the full toolset. | Add `required_tools: []` (or the real list) to the skill's frontmatter, as in step 3. |

## See also

- [Add a skill](../../building/how-to/add-a-skill.md) — `required_tools` and `fallback_unknown`, including the A2A-specific fail-closed exception this page relies on.
- [Why does AgentCard need a drift gate?](../../building/explanation/agent-card-governance.md) — why the signed card's shape can't casually change once peers have anchored a fingerprint to it.
- [Serve Ethos as an OpenAI-compatible backend](../../building/how-to/openai-server-chat.md) — the `/v1/chat/completions` surface this page used to trigger a turn.
