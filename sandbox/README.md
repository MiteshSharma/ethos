# sandbox-dev

A reusable Docker-based VM sandbox for autonomous AI coding, built around a **two-model write/review loop**:

- **Claude Code** writes code
- **OpenAI Codex** reviews code (Linus Torvalds framing, 5-year horizon)
- A `Stop` hook runs the loop automatically — Claude can't finish a turn until Codex approves or the iteration cap is hit

The default target is the `ethos` repo, but everything is configurable for any project.

## Why a sandbox?

Letting an agent write code with `--dangerously-skip-permissions` is powerful but risky. This setup gives you:

- An isolated Linux VM (Docker Desktop on Mac, native on Linux)
- Both `claude` and `codex` CLIs preinstalled, pinned versions
- **Persistent auth** — login once, survives sandbox stop/start/recreate
- A working-tree shared with the host, so changes are immediately visible
- A guaranteed code-review pass before the agent declares "done"

## Why a write/review split?

Single-agent self-review is unreliable: an LLM that just wrote a file is poorly placed to find what's wrong with it. The split:

1. Claude writes code
2. Claude does **Pass 1** itself — typos, dead code, unused imports, lint/typecheck, project-rule violations
3. The Stop hook invokes Codex for **Pass 2** — architectural foot-guns, brittle abstractions, hidden coupling, API choices that will be hard to evolve
4. Claude addresses critical/high findings and re-loops
5. Iteration cap (default 2) prevents infinite cycles

You always see the loop happen — intermediate iterations aren't hidden.

## Prerequisites

| Requirement | Purpose |
|---|---|
| Docker Desktop (Mac) or Docker (Linux) with the `docker sandbox` plugin | VM-based isolation |
| `jq` | JSON parsing in the setup script |
| Git with SSH access to your project's remote | Cloning your repo into the sandbox |

## Quick start

```bash
# 1. Run setup (idempotent — re-run any time)
./sandbox-setup.sh

# 2. Enter the sandbox
docker sandbox run dev

# 3. First time inside: login once
claude          # Anthropic OAuth
codex login     # OpenAI OAuth

# 4. Work
cd ~/personal/sandbox/ethos
git worktree add ../worktree/feat-x -b feat-x
cd ../worktree/feat-x
pnpm install
claude --dangerously-skip-permissions
```

## Setup script

```
./sandbox-setup.sh [--name NAME] [--dir DIR] [--ethos-url URL] [--ethos-branch BRANCH]
```

| Flag | Default | Description |
|---|---|---|
| `--name` | `dev` | Sandbox name |
| `--dir` | `~/personal/sandbox` | Shared directory mounted into the sandbox |
| `--ethos-url` | `git@github.com:ethosagent/ethos.git` | Remote URL of the project to clone |
| `--ethos-branch` | `main` | Branch to track in `$DIR/<repo>` |

Forking for a different project: change the defaults in `sandbox-setup.sh`, or always pass `--ethos-url` / `--ethos-branch` flags.

## Layout

```
~/personal/sandbox/                       ← single mount into the sandbox
├── ethos/                                ← canonical checkout, kept on main (reset --hard each setup)
├── worktree/                             ← feature-branch worktrees go here
├── CLAUDE.md                             ← agent instructions, rendered from sandbox-agent-claude.md
├── .sandbox-statusline.sh                ← Claude statusline command
└── .auth/                                ← persistent credentials + plugins + skills
    ├── claude/                           ← /home/agent/.claude inside the sandbox (symlinked)
    └── codex/                            ← /home/agent/.codex inside the sandbox (symlinked)
```

Don't edit files in `ethos/` directly — the setup script `git reset --hard`s it on every run. Always work in `worktree/<branch-name>`.

## What's inside the sandbox image

Defined in `Dockerfile.sandbox`:

| Layer | Contents |
|---|---|
| Base | `docker/sandbox-templates:shell` (Debian bookworm) |
| Node | Node 24 (NodeSource apt), corepack with pinned `pnpm@10.33.0` |
| AI CLIs | `claude` (claude.ai/install.sh), `codex` (`@openai/codex` via npm) |
| Dev tools | `bat`, `ripgrep` (`rg`), `fd-find` (`fd`), `tmux` |

## Code-review workflow (`openai-reviewer` skill)

Lives at `.agents/skills/openai-reviewer/` (the repo's shared-skills directory). Setup copies every skill under `.agents/skills/` into `$SANDBOX_DIR/.auth/claude/skills/`, where Claude Code auto-discovers them. Add a new directory under `.agents/skills/<name>/` and it ships to sandbox on next setup — no `sandbox-setup.sh` edit needed.

### Manual invocation

```bash
~/.claude/skills/openai-reviewer/scripts/openai-review [<mode>] [--focus <area>]
```

| Mode | Reviews |
|---|---|
| `uncommitted` (default) | Staged + unstaged changes |
| `last-commit` | Most recent commit only |
| `against-main` | Branch + uncommitted vs `main`/`master` |
| `against-origin` | Unpushed commits vs `origin/<branch>` |

| Focus | Narrow scope to |
|---|---|
| `security` | Injection, auth, data exposure, crypto, validation |
| `performance` | Complexity, memory, N+1, blocking, allocations |
| `correctness` | Logic errors, edge cases, null handling, races |
| `style` | Naming, organization, DRY, readability |
| `test` | Coverage gaps, assertion quality, over-mocking, flaky patterns |
| `all` (default) | Comprehensive |

Output is JSON: `{verdict, summary, findings:[{severity, category, file, line, issue, suggestion}]}`.

### Auto-loop (Stop hook)

`scripts/codex-review-hook` is wired as a Claude Code `Stop` hook. After every code-writing turn:

| Outcome | Hook behavior |
|---|---|
| No critical/high findings | Exit 0 — turn ends, "✓ Codex approved" surfaces in transcript |
| Critical/high + iteration < cap | Exit 2 — blocks stop, feeds review JSON back to Claude, Claude continues |
| Iteration cap (default 2) reached | Exit 0 — surfaces remaining issues to user, turn ends |

State is per-session in `$TMPDIR/codex-review/`. Cap can be raised by editing `MAX_ITERATIONS` in `codex-review-hook`.

### Opting out for a single command

```bash
SKIP_CODEX_REVIEW=1 claude  # disables the hook for this session
```

### Linus framing + project rules injection

Every Codex prompt is built from three pieces:
1. The Linus Torvalds framing — blunt, focused on 5-year decay
2. Your repo's `CLAUDE.md` rules (first 8KB) — so Codex respects "no error handling for impossible cases", "no abstractions for single-use code", etc.
3. The diff itself

Without (2), Codex tends to flag code that violates generic best-practice but is correct under your project's conventions.

## Auth persistence

The first time the sandbox is created, the setup script symlinks `/home/agent/.claude` and `/home/agent/.codex` to `$SANDBOX_DIR/.auth/{claude,codex}`. Credentials live on the host filesystem and survive:

- `docker sandbox stop dev` / `start dev`
- Host reboot
- `docker sandbox rm dev` followed by re-running `sandbox-setup.sh`

To fully reset auth: `rm -rf $SANDBOX_DIR/.auth/`.

**Don't mount your host's `~/.claude/` or `~/.codex/`** into the sandbox. macOS and Linux store credentials differently (Keychain vs plain files); mixing them will break auth on both sides.

## Files

| File | Purpose |
|---|---|
| `sandbox-setup.sh` | Idempotent orchestrator (clone, image build, sandbox create, configure) |
| `Dockerfile.sandbox` | Sandbox template image recipe |
| `sandbox-agent-claude.md` | `CLAUDE.md` template rendered into the sandbox shared dir |
| `sandbox-statusline.sh` | Claude Code statusline (yellow "Sandbox" label, model, branch, dirty count) |
| `../.agents/skills/openai-reviewer/SKILL.md` | Skill manifest — routing rules, two-pass flow (lives in the repo's shared-skills dir) |
| `../.agents/skills/openai-reviewer/scripts/openai-review` | Codex wrapper, returns review JSON |
| `../.agents/skills/openai-reviewer/scripts/codex-review-hook` | Stop hook driving the auto-loop |

## Troubleshooting

### "Sandbox already exists"

The script skips creation if the named sandbox exists. To start fresh:

```bash
docker sandbox rm dev
./sandbox-setup.sh
```

Auth survives this because it's stored in `$SANDBOX_DIR/.auth/` on the host.

### Claude or Codex login doesn't persist

Confirm the symlinks were created:

```bash
docker sandbox exec dev ls -la /home/agent/.claude /home/agent/.codex
```

Both should show `-> /…/sandbox/.auth/…`.

### Codex review keeps failing the diff

Check the verdict JSON. The most common cause is Codex demanding generic best-practice changes that your `CLAUDE.md` explicitly forbids — which Claude is supposed to override. If you see this consistently, your `CLAUDE.md` may need to make the rule more explicit so it survives the 8KB injection budget in `openai-review`.

### Want a clean slate

```bash
docker sandbox rm dev
rm -rf ~/personal/sandbox
./sandbox-setup.sh
```

### `superpowers` plugin install failed

The setup script tries to install `superpowers@claude-plugins-official`. If you haven't logged into Claude yet, this fails with "plugin not found in marketplace". Login first, then re-run setup.

## Forking this for a different project

1. Change the defaults in `sandbox-setup.sh` (`SANDBOX_DIR`, `ETHOS_URL`, `ETHOS_BRANCH`)
2. Update the variable names if you don't want them called `ETHOS_*`
3. Update `sandbox-agent-claude.md` for your project's commands (replace `pnpm dev/check/lint`)
4. Keep `.agents/skills/openai-reviewer/` as-is — it reads your project's `CLAUDE.md` automatically
5. If your project has `node_modules` worth caching, consider mounting a host npm/pnpm store into the sandbox
