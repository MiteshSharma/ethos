#!/bin/bash
# sandbox-setup.sh — Idempotent sandbox setup for ethos.
#
# Layout: $SANDBOX_DIR is mounted into the sandbox.
#   $SANDBOX_DIR/ethos     — fresh clone of ethos, kept on $ETHOS_BRANCH
#   $SANDBOX_DIR/worktree  — worktrees of ethos for feature branches
#   $SANDBOX_DIR/.auth     — persistent Claude + Codex credentials
#
# Usage: ./sandbox-setup.sh [--name NAME] [--dir DIR] [--ethos-url URL] [--ethos-branch BRANCH]
#   --name           Sandbox name (default: dev)
#   --dir            Sandbox shared directory (default: ~/personal/sandbox)
#   --ethos-url      Ethos remote URL (default: git@github.com:ethosagent/ethos.git)
#   --ethos-branch   Ethos branch to track (default: main)

set -euo pipefail

SANDBOX_NAME="dev"
SANDBOX_DIR="$HOME/personal/sandbox"
ETHOS_URL="git@github.com:ethosagent/ethos.git"
ETHOS_BRANCH="main"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      [[ $# -ge 2 ]] || { echo "Error: --name requires an argument"; exit 1; }
      SANDBOX_NAME="$2"; shift 2 ;;
    --dir)
      [[ $# -ge 2 ]] || { echo "Error: --dir requires an argument"; exit 1; }
      SANDBOX_DIR="$2"; shift 2 ;;
    --ethos-url)
      [[ $# -ge 2 ]] || { echo "Error: --ethos-url requires an argument"; exit 1; }
      ETHOS_URL="$2"; shift 2 ;;
    --ethos-branch)
      [[ $# -ge 2 ]] || { echo "Error: --ethos-branch requires an argument"; exit 1; }
      ETHOS_BRANCH="$2"; shift 2 ;;
    *)      echo "Unknown option: $1"; exit 1 ;;
  esac
done

mkdir -p "$SANDBOX_DIR"
SANDBOX_DIR="$(cd "$SANDBOX_DIR" && pwd)"

echo "🚀 Setting up sandbox '$SANDBOX_NAME' at $SANDBOX_DIR"

# --- Directory structure ---

echo ""
echo "📁 Creating directory structure"
mkdir -p "$SANDBOX_DIR/worktree"
echo "  worktree/"

# --- Ethos checkout ---

ETHOS_DIR="$SANDBOX_DIR/ethos"

echo ""
echo "📦 Ethos checkout"
if [ -d "$ETHOS_DIR/.git" ]; then
  echo "  🔄 updating to $ETHOS_BRANCH..."
  git -C "$ETHOS_DIR" fetch origin || { echo "  ❌ FAILED to fetch"; exit 1; }
  git -C "$ETHOS_DIR" checkout "$ETHOS_BRANCH" || { echo "  ❌ FAILED to checkout $ETHOS_BRANCH"; exit 1; }
  git -C "$ETHOS_DIR" reset --hard "origin/$ETHOS_BRANCH" || { echo "  ❌ FAILED to reset to origin/$ETHOS_BRANCH"; exit 1; }
  echo "  ✅ up to date."
else
  echo "  📥 cloning $ETHOS_URL ($ETHOS_BRANCH)..."
  git clone --branch "$ETHOS_BRANCH" "$ETHOS_URL" "$ETHOS_DIR" || { echo "  ❌ FAILED to clone"; exit 1; }
  echo "  ✅ cloned."
fi

# --- CLAUDE.md for sandbox agent ---

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "📝 Rendering CLAUDE.md into sandbox directory"
if [ -f "$SCRIPT_DIR/sandbox-agent-claude.md" ]; then
  sed "s|{{SANDBOX_DIR}}|$SANDBOX_DIR|g" "$SCRIPT_DIR/sandbox-agent-claude.md" > "$SANDBOX_DIR/CLAUDE.md"
  echo "  ✅ Written to $SANDBOX_DIR/CLAUDE.md"
else
  echo "  ⚠️  sandbox-agent-claude.md not found — skipping"
fi

# --- Build sandbox template image ---

SANDBOX_IMAGE="ethos-sandbox:latest"

echo ""
echo "🐳 Building sandbox template image"
docker build -t "$SANDBOX_IMAGE" -f "$SCRIPT_DIR/Dockerfile.sandbox" "$SCRIPT_DIR" || {
  echo "  ❌ FAILED to build sandbox image"
  exit 1
}
echo "  ✅ Built $SANDBOX_IMAGE"

# --- Docker sandbox ---

echo ""
echo "📦 Creating Docker sandbox"
if docker sandbox ls -q 2>/dev/null | grep -qx "$SANDBOX_NAME"; then
  echo "  ✅ Sandbox '$SANDBOX_NAME' already exists — skipping creation."
else
  echo "  🔧 Creating sandbox '$SANDBOX_NAME'..."
  docker sandbox create --name "$SANDBOX_NAME" --template "$SANDBOX_IMAGE" \
    shell "$SANDBOX_DIR" || {
    echo "  ❌ FAILED to create sandbox — is Docker running?"
    exit 1
  }
  echo "  ✅ Created."
fi

# --- Configure Claude inside sandbox ---

echo ""
echo "⚙️  Configuring Claude inside sandbox"

sandbox_exec() {
  docker sandbox exec "$SANDBOX_NAME" sh -c "$1" 2>&1
}

# Persist Claude + Codex auth on the host so login survives `docker sandbox rm`.
# ~/.claude and ~/.codex inside the sandbox are symlinked to $SANDBOX_DIR/.auth/.
echo "  🔐 Setting up persistent auth dirs..."
mkdir -p "$SANDBOX_DIR/.auth/claude" "$SANDBOX_DIR/.auth/codex"
sandbox_exec "
  if [ -d /home/agent/.claude ] && [ ! -L /home/agent/.claude ]; then
    cp -a /home/agent/.claude/. $SANDBOX_DIR/.auth/claude/ 2>/dev/null || true
    rm -rf /home/agent/.claude
  fi
  [ -L /home/agent/.claude ] || ln -s $SANDBOX_DIR/.auth/claude /home/agent/.claude

  if [ -d /home/agent/.codex ] && [ ! -L /home/agent/.codex ]; then
    cp -a /home/agent/.codex/. $SANDBOX_DIR/.auth/codex/ 2>/dev/null || true
    rm -rf /home/agent/.codex
  fi
  [ -L /home/agent/.codex ] || ln -s $SANDBOX_DIR/.auth/codex /home/agent/.codex
"
echo "  ✅ Auth dirs persisted at $SANDBOX_DIR/.auth/"

# Strip Docker Sandbox's proxy-managed API keys so `claude login` / `codex login` can OAuth.
# /etc/sandbox-persistent.sh is sourced by .bashrc and exported as BASH_ENV for child shells.
echo "  🧹 Unsetting proxy-managed ANTHROPIC_API_KEY / OPENAI_API_KEY in sandbox shell init..."
sandbox_exec "
  grep -q 'unset ANTHROPIC_API_KEY OPENAI_API_KEY' /etc/sandbox-persistent.sh 2>/dev/null || \
    printf 'unset ANTHROPIC_API_KEY OPENAI_API_KEY ANTHROPIC_AUTH_TOKEN\n' >> /etc/sandbox-persistent.sh
"
echo "  ✅ Anthropic + OpenAI proxy keys will be unset on shell entry."

# Configure git identity from host
GIT_USER_NAME="$(git config --global user.name 2>/dev/null)" || true
GIT_USER_EMAIL="$(git config --global user.email 2>/dev/null)" || true
if [ -n "$GIT_USER_NAME" ] && [ -n "$GIT_USER_EMAIL" ]; then
  echo "  👤 Setting git identity: $GIT_USER_NAME <$GIT_USER_EMAIL>"
  sandbox_exec "git config --global user.name '$GIT_USER_NAME'"
  sandbox_exec "git config --global user.email '$GIT_USER_EMAIL'"
else
  echo "  ⚠️  Host git identity not found — git commits inside sandbox will fail"
fi

# Install all skills from the repo's .agents/skills/ directory.
# Any skill that ships with the repo flows into the sandbox automatically —
# add a new directory under .agents/skills/<name>/ and it's installed on next setup.
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILLS_SRC="$REPO_ROOT/.agents/skills"
SKILLS_DST="$SANDBOX_DIR/.auth/claude/skills"
HOOK_PATH="$SKILLS_DST/openai-reviewer/scripts/codex-review-hook"
if [ -d "$SKILLS_SRC" ]; then
  echo "  📋 Installing skills from .agents/skills/..."
  mkdir -p "$SKILLS_DST"
  cp -R "$SKILLS_SRC/." "$SKILLS_DST/"
  chmod +x "$SKILLS_DST"/*/scripts/* 2>/dev/null || true
  INSTALLED=$(find "$SKILLS_SRC" -mindepth 1 -maxdepth 1 -type d ! -name '.*' | wc -l | tr -d ' ')
  echo "  ✅ Installed $INSTALLED skill(s)."
fi

# Check-quality hook: change-aware quality gate (lint, typecheck, scoped tests, docs)
CHECK_QUALITY_HOOK_PATH="$HOOKS_DST/check-quality.sh"
if [ -f "$HOOKS_SRC/check-quality.sh" ]; then
  echo "  🔍 Installing check-quality hook..."
  mkdir -p "$HOOKS_DST"
  sed -e "s|{{ETHOS_DIR}}|$ETHOS_DIR|g" \
      "$HOOKS_SRC/check-quality.sh" > "$CHECK_QUALITY_HOOK_PATH"
  chmod +x "$CHECK_QUALITY_HOOK_PATH"
  echo "  ✅ Quality gate hook installed at $CHECK_QUALITY_HOOK_PATH"
fi

# Session-audit hook command (sandbox-internal path via ~/.claude symlink)
SESSION_AUDIT_HOOK_CMD=""
if [ -f "$SKILLS_DST/session-audit/scripts/parse-transcript" ] && \
   [ -f "$SKILLS_DST/session-audit/scripts/format-output" ]; then
  SESSION_AUDIT_HOOK_CMD="python3 /home/agent/.claude/skills/session-audit/scripts/parse-transcript 2>/dev/null | python3 /home/agent/.claude/skills/session-audit/scripts/format-output 2>/dev/null"
fi

# Install PreToolUse hook (forbid direct edits to canonical ethos checkout)
HOOKS_SRC="$SCRIPT_DIR/hooks"
HOOKS_DST="$SANDBOX_DIR/.auth/claude/hooks"
PRETOOLUSE_HOOK_PATH="$HOOKS_DST/block-non-worktree-edits.sh"
if [ -f "$HOOKS_SRC/block-non-worktree-edits.sh" ]; then
  echo "  🚧 Installing PreToolUse hook..."
  mkdir -p "$HOOKS_DST"
  sed -e "s|{{ETHOS_DIR}}|$ETHOS_DIR|g" \
      -e "s|{{WORKTREE_DIR}}|$SANDBOX_DIR/worktree|g" \
      "$HOOKS_SRC/block-non-worktree-edits.sh" > "$PRETOOLUSE_HOOK_PATH"
  chmod +x "$PRETOOLUSE_HOOK_PATH"
  echo "  ✅ Hook installed at $PRETOOLUSE_HOOK_PATH"
fi

# Configure statusline + Stop hook + review allowlist in a single settings.json patch
STATUSLINE_PATH=""
if [ -f "$SCRIPT_DIR/sandbox-statusline.sh" ]; then
  echo "  📊 Copying statusline script..."
  cp "$SCRIPT_DIR/sandbox-statusline.sh" "$SANDBOX_DIR/.sandbox-statusline.sh"
  chmod +x "$SANDBOX_DIR/.sandbox-statusline.sh"
  STATUSLINE_PATH="$SANDBOX_DIR/.sandbox-statusline.sh"
fi

echo "  ⚙️  Patching Claude settings.json (statusline + hooks + permissions)..."
EXISTING_SETTINGS="$(sandbox_exec "cat /home/agent/.claude/settings.json 2>/dev/null || echo '{}'")"
echo "$EXISTING_SETTINGS" \
  | jq \
      --arg statusline "$STATUSLINE_PATH" \
      --arg hookcmd "$HOOK_PATH" \
      --arg pretoolusehook "$PRETOOLUSE_HOOK_PATH" \
      --arg session_audit_cmd "$SESSION_AUDIT_HOOK_CMD" \
      --arg check_quality_cmd "$CHECK_QUALITY_HOOK_PATH" '
    . as $base
    | (if ($statusline | length) > 0
         then . + {"statusLine":{"type":"command","command":$statusline}}
         else . end)
    | . + {
        "permissions": ((.permissions // {}) + {
          "allow": (((.permissions.allow // []) + [
            "Bash(openai-review *)",
            "Bash(*/openai-review *)"
          ]) | unique)
        })
      }
    | (
        [
          (if ($hookcmd | length) > 0
             then {"matcher":"*","hooks":[{"type":"command","command":$hookcmd}]}
             else empty end),
          (if ($session_audit_cmd | length) > 0
             then {"matcher":"","hooks":[{"type":"command","command":$session_audit_cmd,"timeout":30}]}
             else empty end),
          (if ($check_quality_cmd | length) > 0
             then {"matcher":"","hooks":[{"type":"command","command":$check_quality_cmd,"timeout":120}]}
             else empty end)
        ]
      ) as $stop_hooks
    | (if ($stop_hooks | length) > 0
         then . + {"hooks": ((.hooks // {}) + {"Stop": $stop_hooks})}
         else . end)
    | (if ($pretoolusehook | length) > 0
         then . + {"hooks": ((.hooks // {}) + {
              "PreToolUse": [{"matcher":"Edit|Write|MultiEdit|NotebookEdit","hooks":[{"type":"command","command":$pretoolusehook}]}]
            })}
         else . end)
  ' > "$SANDBOX_DIR/.claude-settings-tmp.json"
sandbox_exec "mkdir -p /home/agent/.claude && cp $SANDBOX_DIR/.claude-settings-tmp.json /home/agent/.claude/settings.json"
rm -f "$SANDBOX_DIR/.claude-settings-tmp.json"
echo "  ✅ Settings configured."

# Install superpowers plugin
echo "  🔌 Installing superpowers@claude-plugins-official..."
sandbox_exec "claude plugin marketplace update claude-plugins-official" >/dev/null 2>&1 || true
sandbox_exec "claude plugin install superpowers@claude-plugins-official" || {
  echo "  ⚠️  Failed to install superpowers — login to claude first, then re-run this script"
}

echo ""
echo "✨ Sandbox '$SANDBOX_NAME' ready!"
echo ""
echo "  📂 Sandbox:   $SANDBOX_DIR"
echo "  📦 Ethos:     $SANDBOX_DIR/ethos"
echo "  🌿 Worktrees: $SANDBOX_DIR/worktree"
echo ""
echo "  🎯 Run:  docker sandbox run $SANDBOX_NAME"
