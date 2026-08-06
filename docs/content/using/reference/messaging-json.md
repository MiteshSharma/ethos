---
title: messaging.json reference
description: "Per-personality outbound allowlist for the send_message tool. Maps personality id to <platform>:<target> entries; default-deny."
kind: reference
audience: user
slug: messaging-json
updated: 2026-05-17
---

# `messaging.json` reference

`~/.ethos/messaging.json` is the operator-level allowlist for the [`send_message`](../../building/reference/messaging-tools.md) tool. Read once at gateway boot. Without an entry for a personality, all outbound sends from that personality are denied — the file is the only path to enable cross-channel posting.

## Synopsis {#synopsis}

```json
{
  "engineer": ["slack:C0123ABC", "telegram:-100123"],
  "researcher": ["*"],
  "coordinator": ["slack:C0ABCDEF", "slack:C1234567", "email:ops@acme.com"]
}
```

| Key | Value |
|---|---|
| Top-level key | A [personality](../../getting-started/glossary.md#personality) id (matches the directory name under `~/.ethos/personalities/` or a bundled personality id) |
| Value | An array of `<platform>:<target>` strings, or the wildcard `"*"` |

Source: [`packages/wiring/src/index.ts` `loadMessagingAllowlist()`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/index.ts).

## Entry format {#entry-format}

Each entry in the array is a colon-joined `<platform>:<target>` string.

| Platform prefix | Target format | Notes |
|---|---|---|
| `slack` | Channel ID (`C0123ABC`) or user ID (`U0123ABC`) | Not channel **names** — the Slack API ignores names here. Right-click channel → Copy link → grab the `C…`. |
| `telegram` | Numeric chat ID (`-100123…` for groups; positive integers for DMs) or `@channelname` | Get group chat ID from `@RawDataBot` or from gateway logs after any message. |
| `discord` | Channel ID (snowflake, e.g. `1234567890123456789`) | Enable Discord Developer Mode → right-click channel → Copy ID. |
| `email` | RFC 5322 email address | The recipient. |

## Wildcard {#wildcard}

`"*"` permits **every** target on **every** platform for that personality. Equivalent to `["slack:*", "telegram:*", "discord:*", "email:*"]` and any combination thereof. Useful for:

- **Testing** the end-to-end flow before you know the real channel IDs.
- **Trusted ops personalities** that need to push to operator-decided targets without re-listing them.

Not recommended for personalities that handle untrusted input — a prompt-injected message could direct the agent to send to attacker-controlled targets if the wildcard is set.

## Loading semantics {#loading}

1. Gateway boot reads the file once via `FsStorage.read`.
2. JSON parse failure or missing file → empty map → all sends denied. Same posture as before this hook existed.
3. The wiring layer builds a `Map<personalityId, string[]>` and passes a `getAllowedTargets(personalityId)` callback into the tool factory.
4. At call time, the tool checks `<platform>:<target>` against the personality's list; missing entry = denied with a clear error message.
5. **No hot reload.** Edits require `Ctrl-C` + `ethos gateway` again. Same pattern as `mcp.json`.

## Errors {#errors}

| Symptom | Cause | Fix |
|---|---|---|
| `Target "slack:C..." is not in the personality's allowed messaging targets. Allowed: none` | Personality missing from the file, or empty array | Add entry or `"*"` |
| `Target "..." is not in the personality's allowed messaging targets. Allowed: slack:C0123, ...` | Specific target not on the list | Add it explicitly, switch to `"*"`, or pick a target that's listed |
| Engineer says "I don't have messaging permissions" but no tool error fires | LLM is hallucinating refusal — the tool didn't even run | Prompt more explicitly: "Use the send_message tool to post X to slack:C0123". The tool itself doesn't gate by capability, only by allowlist. |
| Edits to the file don't take effect | No hot reload | Restart `ethos gateway` |

## Examples {#examples}

### Engineer testing flow {#example-engineer-testing}

```json
{
  "engineer": ["*"]
}
```

Allows engineer to send anywhere while you wire up the gateway. Replace with explicit targets before deploying.

### Production lockdown {#example-production}

```json
{
  "engineer": [
    "slack:C0ENGINEERS",
    "slack:C0DEPLOY-ALERTS"
  ],
  "researcher": [
    "slack:C0RESEARCH",
    "email:research@acme.com"
  ],
  "coordinator": [
    "slack:C0ENGINEERS",
    "slack:C0RESEARCH",
    "telegram:-1001234567890"
  ]
}
```

Each personality has explicit targets. No wildcards. Adding a new channel is a deliberate operator action.

### Cron notifier {#example-cron-notifier}

```json
{
  "daily-report": [
    "slack:C0STANDUP",
    "email:team@acme.com"
  ]
}
```

A personality bound to a `cron` job posts daily; allowlist restricts it to the two channels you want notifications in.

## File permissions {#permissions}

The file is plain JSON — no secrets — so default umask is fine. Targets aren't secrets, but they identify your channels — keep the file out of public commits if you keep dotfiles in git. There's no `${secrets:<ref>}` indirection here because there's nothing sensitive to indirect through.

## See also {#see-also}

- [`send_message` tool reference](../../building/reference/messaging-tools.md) — the tool that reads this file.
- [Send cross-channel messages](../how-to/send-cross-channel-messages.md) — operator how-to with end-to-end Telegram→Slack walkthrough.
- [Config field reference](config-yaml.md) — the broader `~/.ethos/config.yaml` schema.
- [`channel_filter` reference](#) — inbound message gating (peer policy on the inbound side).
