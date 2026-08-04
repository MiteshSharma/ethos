---
title: Set up approval gates for dangerous tool calls
description: Configure the safety.approvalMode knob so dangerous tool calls pause for human review instead of firing unsupervised.
kind: how-to
audience: user
slug: set-up-approval-gates
time: 10 min
updated: 2026-08-05
---

Some tool calls write files, run shell commands, or hit the network. You do not want them firing unsupervised. Approval gates make the agent pause and ask before the dangerous call runs — or refuse it outright.

## Task

Configure a [personality](../../getting-started/glossary.md#personality)'s `safety.approvalMode` so the agent pauses (or doesn't) before a dangerous tool call.

## Result

The chosen personality routes every `dangerous` classification through the chosen mode — modal prompt, reviewer-judged auto-approval, or auto-fire — while the `blocked` hardline floor continues to refuse the worst commands no matter what.

## Prereqs

- A personality you own at `~/.ethos/personalities/<id>/` (built-ins shadow safely — copy with `ethos personality duplicate <built-in> <id>` if you want to override).
- Familiarity with the [personality config reference](../reference/personality-yaml.md).

## 1. Pick the right mode for the surface

Ethos's safety classifier sorts every tool call into one of three buckets. `safe` calls auto-fire. `blocked` calls are refused unconditionally — they are the hardline floor in [extensions/tools-terminal/src/guard.ts](https://github.com/ethosagent/ethos/blob/main/extensions/tools-terminal/src/guard.ts) (recursive `rm -rf /` or `~`, `dd of=/dev/sdX`, `mkfs`, `chmod` with setuid, writes to `/etc/sudoers` or `~/.ssh/authorized_keys`, `DROP TABLE`, fork bombs, etc.). `dangerous` calls are the middle band — destructive enough to want a human in the loop, not so destructive that they should never run.

`safety.approvalMode` decides what happens to that middle band.

| Mode | What happens on `dangerous` | When to pick it |
|---|---|---|
| `manual` *(default)* | Surface an approval prompt; wait for Allow / Deny. | Personal CLI sessions. Web UI personalities. Any time you are sitting at the terminal and can answer in seconds. |
| `smart` | An LLM reviewer judges the call first. `approve` → runs with no prompt. `deny` and `ask` → the approval prompt still fires, carrying the reviewer's reason. | Long-running agent sessions where approval fatigue is the failure mode. Trades latency and reviewer tokens for fewer interruptions. |
| `off` | Auto-fire. `blocked` calls still refuse. | Trusted local automation only — cron, batch runs, headless test rigs. Refused at config load when combined with any channel ingress. |

The hardline `blocked` floor is **non-overridable** — `approvalMode: off` does not unlock `rm -rf /`. That is the point: a regex floor catches the literal command shape even when every other check is bypassed.

## 2. Add the YAML

Open `~/.ethos/personalities/<id>/config.yaml` and add a `safety` block. The shape lives in [packages/types/src/personality.ts](https://github.com/ethosagent/ethos/blob/main/packages/types/src/personality.ts):

```yaml
safety:
  approvalMode: manual
```

`smart` and `off` are the other two legal values. Anything else throws at config load:

```
Invalid approvalMode: "ask". Expected one of: manual, smart, off
```

### Turn on smart mode

```yaml
safety:
  approvalMode: smart
```

Under `smart` — and only under `smart` — four built-in tools are flagged as consequential and routed to the reviewer: `terminal`, `write_file`, `patch_file`, and `process_start` (`SMART_MODE_CONSEQUENTIAL_TOOLS` in [packages/wiring/src/danger-predicate.ts](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/danger-predicate.ts)). Read-only tools such as `read_file`, `search_files`, and `web_search` are deliberately excluded: flagging a lookup would buy a reviewer round-trip per read and no safety. `run_code` is excluded too, because it already executes inside an isolated container.

`manual` and `off` see an unchanged flag set: hardline terminal commands, plus whatever the deployment marked `alwaysAsk`. Switching a personality to `smart` therefore widens what gets gated, it does not narrow it.

Four things worth knowing before you rely on it:

- **The reviewer fails closed.** A provider error, a round-trip over 15 seconds, or a response that isn't the expected JSON all resolve to `ask` — which routes to the normal approval prompt. No failure path returns `approve`.
- **Verdicts are cached per exact call**, keyed on `sha256(tool name + canonicalized args)`. Approving `rm -rf ./build` does not approve `rm -rf ./src`; re-issuing the identical call costs no second review.
- **Hardline `blocked` commands never reach the reviewer.** They short-circuit ahead of it, so no verdict can auto-approve one.
- **Smart mode is wired on `ethos serve`, `ethos gateway`, and the desktop app** — the three surfaces that own an approval flow. `ethos chat` is unaffected (see step 5).

### Deny rules

`safety.denyRules` is a list of case-sensitive substrings matched against `<tool-name> <canonical-json-args>`, so the rule `git push --force` matches a `terminal` call whose `command` contains that text. A match surfaces the reason `denied by personality deny rule: git push --force`.

Deny rules are the floor. They are matched **before** the approval-mode dispatch, so a rule binds in every mode — including `approvalMode: off` with auto-approve enabled. This inverts the usual precedence intuition: modes can only make a call stricter, never looser. A matched call still reaches the approval prompt on surfaces that have one — a rule refuses the *machine*, not the human at the modal — and when the human denies, the agent receives both halves: `denied by user — denied by personality deny rule: git push --force`.

**Not loadable from `config.yaml` yet.** The personality loader parses `safety.approvalMode` but not `safety.denyRules` — see `buildSafetyConfig` in [extensions/personalities/src/index.ts](https://github.com/ethosagent/ethos/blob/main/extensions/personalities/src/index.ts). A `denyRules:` list in a personality's `config.yaml` is silently dropped at load, matches nothing, and gates nothing. The field is enforced by the danger predicate and covered by tests; the config path to it is missing. Do not treat a `denyRules` block as protection today.

## 3. Reload the personality

Personalities are mtime-cached. Save `config.yaml` and the next turn picks up the new mode — no restart, no `/new`. Confirm with:

```
ethos personality show <id> --json | jq .config.safety
```

```json
{
  "approvalMode": "smart"
}
```

The rendered character sheet (`ethos personality show <id>` without `--json`) covers routing, memory, toolset, and filesystem reach — it does not print the safety block. Use `--json` to audit approval mode.

## 4. Refuse the unsafe combination

`approvalMode: off` paired with any of `platform: telegram | discord | slack | whatsapp | email` is rejected at config load:

```
personality "deploy-bot" has approvalMode: off but is bound to channel "telegram".
       Remote senders + auto-approve = remote-driven destructive actions.
       Either: (a) move approvalMode to 'smart' or 'manual', or
               (b) remove channel bindings from this personality (cli/cron only).
       This combination is not configurable; it is rejected at config load.
```

The check lives in [extensions/personalities/src/index.ts](https://github.com/ethosagent/ethos/blob/main/extensions/personalities/src/index.ts) and runs every time the personality loads. There is no flag to override it. A bot that takes input from strangers and auto-approves destructive actions is the catastrophic combination; the framework refuses to boot it.

## 5. Know what approval looks like on each surface

The mode is the same across surfaces. The *prompt* differs by what the surface can render.

### CLI (`ethos chat`)

The CLI does not have an interactive approval flow. `dangerous` terminal commands that hit the hardline blocklist surface as a tool error in the transcript:

```
Command blocked: recursive force-delete of root or home directory.
This operation requires explicit human approval before proceeding.
```

The agent gets the error back as a tool result and continues the turn — usually by trying a less destructive approach or asking you what to do. `manual` mode on the CLI today only affects the hardline floor; non-hardline `dangerous` calls auto-fire because the CLI has no modal to surface. If you need interactive approval, run `ethos serve` and use the web UI.

### Web UI (`ethos serve`)

The web UI ships the full flow. A `dangerous` call posts an approval card anchored to the personality bar (`apps/web/src/components/chat/ApprovalModal.tsx`) with the tool name, reason, and a JSON-formatted args preview. You pick one of three scopes:

- **Just this command** — allow this single invocation, ask again next time.
- **This exact command** — allow this tool with these exact arguments forever.
- **Any args for this tool** — allow every future invocation of this tool.

Allow or Deny resolves the suspended `before_tool_call` hook. The card updates in place to show the outcome. Hardline `blocked` calls never reach the modal — they error out before the prompt.

### Slack and Telegram

Both adapters implement `ApprovalCapableAdapter` and post an interactive approval card with Allow / Deny buttons in the originating conversation (DM or channel). The flow is wired in [apps/ethos/src/commands/gateway.ts](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/commands/gateway.ts) and binds the approval to the user whose message triggered the turn — a bystander in the channel cannot click Allow on a tool call they did not request. The card updates in place to show who decided what.

Threads work on Slack (the card posts in the same thread as the inbound message). On Telegram the card posts as a reply to the triggering message.

### Discord and email

Neither adapter implements `ApprovalCapableAdapter` yet. A `dangerous` call from a Discord or email-driven turn fails closed — the approval coordinator denies it because there is no surface to render the prompt. Use Slack or Telegram if you need channel-driven approvals.

## Verify

- `ethos personality show <id> --json | jq .config.safety` — prints `{"approvalMode": "<mode>"}`.
- Save `approvalMode: off` on a personality with `platform: telegram` — the next personality load throws the rejection above.
- Save `approvalMode: invalid` — the next load throws `Invalid approvalMode: "invalid". Expected one of: manual, smart, off`.
- In the web UI, ask the personality to run a hardline-matching command (e.g. `rm -rf ~/.ssh`) — the call surfaces as a tool error, not as an approval card, confirming the hardline floor is upstream of the modal.
- On `approvalMode: smart`, ask the personality to write a file in the web UI. Either no card appears (the reviewer approved) or the card's reason reads `denied by reviewer: <one sentence>` — both confirm the reviewer ran.

## Troubleshoot

| Symptom | Likely cause | Fix |
|---|---|---|
| `Invalid approvalMode: "X". Expected one of: manual, smart, off` | A typo in `config.yaml` — only the three literal values are accepted. | Pick `manual`, `smart`, or `off`. |
| `personality "X" has approvalMode: off but is bound to channel "telegram"` | `off` on a personality with `platform: telegram \| discord \| slack \| whatsapp \| email`. | Move to `smart` or `manual`, or remove the `platform` binding so the personality is CLI/cron only. |
| `dangerous` calls in CLI fire without prompting | The CLI does not render approval modals. Only the hardline `blocked` floor blocks; the rest auto-fire. | Run via `ethos serve` for the interactive flow, or switch the surface to Slack / Telegram. |
| Slack / Telegram card never appears for a `dangerous` call | The adapter is wired but the personality is not bound to that bot, or the `dangerous` classification did not fire. | Confirm the bot binding in `~/.ethos/config.yaml`. Under `manual` and `off` the band fires only for terminal hardlines and for tools the deployment marks `alwaysAsk`; switch to `approvalMode: smart` to add the four consequential tools. |
| `smart` mode prompts for everything anyway | The reviewer is failing closed — provider error, a round-trip over 15s, or a response that wasn't the expected JSON. Every one resolves to `ask`. | Check that the `model` and provider credentials in `~/.ethos/config.yaml` work; the reviewer runs on the primary model, so a broken primary breaks the reviewer. |
| `safety.denyRules` in `config.yaml` gates nothing | The personality loader does not parse `denyRules` yet — only `approvalMode`. The list is dropped at load. | No workaround today. Use `approvalMode: manual` for the tools you want gated. |

## Caveats

**Teams.** Each personality on a team applies its own `safety.approvalMode` independently. A `manual` engineer and an `off` (cron-only) batch member can coexist on the same board — the gate runs per `before_tool_call`, scoped to the loop that owns the turn. There is no team-level approval setting; the personality is the unit.

**Long-running tools.** Approval suspends the `before_tool_call` hook. The turn sits idle until you decide. There is no timeout on the prompt today — if you walk away from the web UI mid-turn, the suspended hook waits indefinitely. Close the session (`/new`) to release it.

**`approvalMode: off` is documentation-only today.** The danger predicate gates `off` behind an internal `allowAutoApproveDangerousTools` capability flag that no production caller currently sets — see the contract in [packages/wiring/src/danger-predicate.ts](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/danger-predicate.ts). Practically: `off` and `manual` produce the same runtime behaviour right now (everything except the hardline floor auto-fires). Configuring `off` is still meaningful because it records intent and is the load-time signal that rejects the unsafe channel combination. When the cron / batch runner grows an approval surface, `off` will start auto-approving as documented.

**Reviewer spend is not billed to the turn.** Smart-mode reviews consume tokens, and none of it lands in the turn's cost accounting or in `estimatedCostUsd` on the `usage` event. There is no path from a `before_tool_call` hook into `sessionCosts` — closing it means a contract change under `packages/types/`. The kanban completion verifier and the eval-harness scorers discard usage the same way. Volume is bounded rather than measured: the reviewer fires only for calls that already reached the danger band, and repeats are served from the verdict cache. Attribution is a follow-up.

**The reviewer runs on your primary model.** There is no `auxiliary.approvals` config block yet, so `smart` reviews cost primary-model tokens and primary-model latency — not the cheap-model bill the mode's name suggests. Budget for it before turning `smart` on with an expensive `model:` in `~/.ethos/config.yaml`.

**Three denials in a row stop the turn.** After three consecutive `before_tool_call` denials the loop emits a `halt` event (`Stopped: 3 tool calls denied in a row — retrying will not help`) and stops, on the theory that an agent that has been refused three times will not guess its way to an approval. The count is hard-coded — there is no config knob. Only approval denials advance it; a batch in which some tool actually ran restarts the count at that batch's denials instead of adding to the streak.

**Async approval on channels.** Slack and Telegram approvals are not time-bounded either. A button left unclicked holds the turn open until the session ends. For DMs that means one user one decision; for channels it means whoever triggered the turn is the only one whose click counts.

## See also

- [Personality config reference](../reference/personality-yaml.md) — every field on `safety:` and the rest of `config.yaml`.
- [What are the built-in personalities, and why these three?](../explanation/built-in-personalities.md) — how the built-ins handle approval modes by default.
- [Security overview](../../security/overview.md) — where approval gates sit in the trust model.
- [Slash commands reference](../reference/slash-commands.md) — `/personality` to switch the active role mid-conversation.
