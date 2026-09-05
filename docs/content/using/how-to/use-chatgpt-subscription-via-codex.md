---
title: Use a ChatGPT subscription for coding work
description: "Route Ethos's coding delegations through the Codex CLI so inference bills against your ChatGPT Plus / Pro subscription, not the per-token API."
kind: how-to
audience: user
slug: use-chatgpt-subscription-via-codex
time: "5 min"
updated: 2026-09-05
---

## Task

Wire Ethos to **delegate coding work** to the OpenAI Codex CLI, which authenticates against your ChatGPT subscription (Plus $20/mo or Pro $100/mo). Heavy code generation goes through the flat-rate subscription instead of the pay-per-token API key Ethos uses for its own personality reasoning.

## Result

When you ask an Ethos personality to delegate a coding task, it spawns `codex` as a subprocess. Codex runs under your ChatGPT subscription quota, streams output back, and Ethos surfaces the result in the chat. **Zero cost on your Ethos provider key for the delegated turn** — the only Ethos-side cost is the personality's own thinking that decided to delegate.

## Prereqs

- An active ChatGPT **Plus** or **Pro** subscription on the OpenAI account you'll authenticate.
- A working Ethos install with at least one personality that delegates (engineer, coordinator, or any custom personality that lists `delegate_task` in `toolset.yaml`).
- Node 24+ on `PATH` (Codex CLI installs as a global npm package).

## Steps

### 1. Install the Codex CLI

```bash
npm install -g @openai/codex
codex --version    # confirm it's on PATH
```

Codex is an OpenAI-published binary. Ethos does **not** bundle it — it stays a separate install so its update cadence isn't coupled to ours, and so users who don't want it never carry the weight.

### 2. Sign in with your ChatGPT account

```bash
codex login
```

Opens a browser, prompts for your ChatGPT credentials, completes the OAuth flow, and stores a session token in `~/.codex/` (or the platform equivalent). This is where the subscription binding happens — Codex now bills inference against the subscription quota tied to that OAuth identity, not against an `OPENAI_API_KEY`.

Verify:

```bash
codex auth status
# → Logged in as <your-email>  ·  Plan: ChatGPT Plus  (or Pro)
```

### 3. Confirm `coding-agent` is in your personality's effective skill set

The bundled `coding-agent` skill (with its codex adapter) auto-loads on personalities that already have the tools it requires — `terminal`, `read_file`, and `delegate_task` are the keys. The shipped `engineer` personality has all three.

From inside `ethos chat`:

```
You › list your skills
```

The reply should include `coding-agent` somewhere in the list. If not, add `delegate_task` to your personality's `~/.ethos/personalities/<id>/toolset.yaml` and retry.

### 4. Trigger a delegation that names Codex

From the chat, prompt the personality with a task that's worth handing off. The clearer the routing intent, the better:

```
Delegate this to codex: implement a debounce hook in apps/web/src/hooks/useDebounce.ts
with a 5ms test using vitest. Use my ChatGPT subscription, not the Ethos API key.
```

The personality reads its `coding-agent` skill, picks the codex adapter (because you named it), and spawns:

```
codex exec --cd <workingDir> "implement a debounce hook in apps/web/src/hooks/..."
```

Codex output streams back through the agent loop's `tool_progress` channel. You'll see the same stream-and-edit cadence Codex produces in standalone mode.

#### Pick a model

Codex defaults to `gpt-5.6-terra`. To pin a different one, name it in the prompt and the adapter passes `--model` through:

| Model | Use for |
|---|---|
| `gpt-5.6-terra` | Default — everyday, balanced |
| `gpt-5.6-luna` | Fast, cheap — well-scoped edits |
| `gpt-5.6-sol` | Flagship — complex, multi-file work |
| `gpt-6-astra` | Top reasoning |
| `gpt-5.5` | Prior generation |

GPT-5.4 and GPT-5.4 mini retired from Codex sign-in on 2026-08-31 — a delegation that names them fails with an unknown-model error; see [developers.openai.com/codex/models](https://developers.openai.com/codex/models).

### 5. Confirm the bill landed where you wanted

Two signals:

- **Ethos usage**: the chat's bottom status bar or `ethos sessions show <id>` shows the **personality's own** input/output tokens (its decision-to-delegate turn). The delegated work isn't counted here.
- **ChatGPT usage**: `chat.openai.com → Settings → Data Controls → Usage` (or `codex auth status` on newer versions) shows the request landed against your subscription quota.

## Verify

- `which codex` resolves.
- `codex auth status` reports a logged-in session with a plan name.
- A delegated turn in Ethos shows `tool_start: delegate_task` → `tool_end: delegate_task (Xms) ok` in gateway/CLI stdout.
- ChatGPT usage dashboard registers a request matching the delegation time.

## Examples

### Through a chat session

```
You › refactor the auth middleware to use ed25519 keys.
      Delegate the bulk of the work to codex (use my ChatGPT subscription).

ethos › Handing off to codex via coding-agent.
        [tool: delegate_task → codex_exec]
        ...
        (output streams back over ~30s)
        
        Codex finished. Summary:
          - Replaced HMAC-SHA256 with ed25519 in apps/web-api/src/middleware/auth.ts
          - Added test fixtures under apps/web-api/src/__tests__/auth-ed25519.test.ts
          - 14 files changed, +312/-187 lines.
```

### Through a cron job

If you've wired the [cron tools](../../building/reference/cron-tools.md):

```
Schedule a daily 8am cron that asks engineer to delegate to codex:
"audit yesterday's PRs for any commit messages that don't follow conventional-commits;
list violations and link to each."
```

The cron fires under whatever personality you bound to it; that personality delegates to codex; codex's subscription absorbs the work. Cheaper than running the same audit on per-token billing.

## Troubleshoot

**"OpenAI Codex CLI is not installed"** — `npm i -g @openai/codex`, then verify with `codex --version`. The coding-agent adapter probes `which codex` and refuses delegation if absent.

**"Codex CLI is installed but no auth is configured"** — Run `codex login`. If the OAuth window doesn't open in a remote/SSH session, run it locally and copy `~/.codex/auth.json` (or the equivalent) to the remote machine.

**Engineer narrates a coding task without spawning codex** — The model decided not to delegate. Force it: *"Use the `delegate_task` tool with adapter=codex. Do not implement directly."* If the tool still isn't called, check that `delegate_task` and the coding-agent skill are both visible to the personality (see Step 3).

**Codex runs but the output never streams back** — Network firewall, or Codex's output is buffered. Test Codex standalone first: `codex exec "say hi"` should print streaming output. If standalone works but Ethos doesn't see it, file a bug — that's an adapter-side regression in `coding-agent`.

**Inference is still billing against my OpenAI API key** — Then Ethos's own LLM is doing the work, not Codex. Check: did the agent actually call `delegate_task`? Look at `tool_start` events in gateway/CLI stdout. If absent, the personality didn't route through codex; re-prompt with explicit "delegate to codex" wording.

## What this does NOT do

- **Run every personality's reasoning under your ChatGPT subscription.** Only the delegated work bills there. The engineer's own thinking (the turn where it decides to delegate, formats the prompt, summarises the result) still hits whatever provider you have configured in `~/.ethos/config.yaml`.
- **Provide first-class `provider: chatgpt-subscription` for Ethos personalities.** That would require an OAuth-subscription proxy that bridges the consumer-app OAuth flow to an OpenAI-compatible HTTP surface. The pattern is doable but carries ToS and maintenance trade-offs we haven't taken on. Coding-delegation via the Codex subprocess is the sanctioned path today.
- **Replace your Ethos provider key.** You still need an Anthropic / OpenAI / Azure / etc. key for the personality's own inference. Codex is an offload target, not a primary provider.

## See also

- [`coding-agent`](https://github.com/ethosagent/ethos/blob/main/skills/data/software-development/coding-agent/SKILL.md) — the bundled skill with adapters for claude-code, codex, opencode, and pi.
- [Codex CLI documentation](https://github.com/openai/codex) — auth flow + flags reference.
- [Cron tools reference](../../building/reference/cron-tools.md) — scheduling recurring delegations.
- [`delegate_task` tool](../../building/reference/tool-interface.md) — the framework primitive `coding-agent` builds on.
