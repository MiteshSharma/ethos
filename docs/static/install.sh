#!/usr/bin/env bash
#
# Ethos installer — installs the `ethos` CLI globally via npm.
#
# Usage:
#   curl -fsSL https://ethosagent.ai/install.sh | bash
#   curl -fsSL https://ethosagent.ai/install.sh | bash -s -- --setup
#   curl -fsSL https://ethosagent.ai/install.sh | bash -s -- --version 0.2.0
#
# What it does:
#   1. Detects platform (macOS or Linux; bails on Windows in v1)
#   2. Checks for Node 24+; installs it via nvm if missing
#   3. Runs `npm install -g @ethosagent/cli@<version>`
#   4. Optionally runs `ethos setup` immediately after install
#
# Source: https://github.com/MiteshSharma/ethos/blob/main/docs/static/install.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

readonly REQUIRED_NODE_MAJOR=24
readonly NVM_VERSION="v0.40.1"
readonly PACKAGE="@ethosagent/cli"

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

RUN_SETUP=0
PIN_VERSION="latest"

while [ $# -gt 0 ]; do
  case "$1" in
    --setup)
      RUN_SETUP=1
      shift
      ;;
    --version)
      PIN_VERSION="${2:-latest}"
      shift 2
      ;;
    --help|-h)
      cat <<'EOF'
ethos installer

Usage:
  curl -fsSL https://ethosagent.ai/install.sh | bash
  curl -fsSL https://ethosagent.ai/install.sh | bash -s -- --setup
  curl -fsSL https://ethosagent.ai/install.sh | bash -s -- --version 0.2.0

Flags:
  --setup           Run `ethos setup` immediately after install.
  --version <v>     Install a specific version (default: latest).
  --help, -h        Show this help.

Supported platforms: macOS (x64, arm64), Linux (x64, arm64).
Requires: Node 24+ (installed automatically via nvm if missing).
EOF
      exit 0
      ;;
    *)
      printf 'Unknown flag: %s\nRun with --help to see supported flags.\n' "$1" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Output helpers (shellcheck-clean, color only when stderr is a TTY)
# ---------------------------------------------------------------------------

if [ -t 2 ]; then
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
  C_DIM=$'\033[2m'
  C_RESET=$'\033[0m'
else
  C_GREEN=''
  C_YELLOW=''
  C_RED=''
  C_DIM=''
  C_RESET=''
fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
note() { printf '%s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
warn() { printf '%s⚠%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

OS="$(uname -s 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"

case "$OS" in
  Darwin)
    PLATFORM="macOS"
    ;;
  Linux)
    PLATFORM="Linux"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    die "Windows is not supported in this release. Run this script in WSL (https://learn.microsoft.com/windows/wsl/install) or on macOS / Linux."
    ;;
  *)
    die "Unsupported OS: $OS. Ethos supports macOS and Linux."
    ;;
esac

case "$ARCH" in
  x86_64|amd64|arm64|aarch64)
    : # supported
    ;;
  *)
    die "Unsupported architecture: $ARCH (need x86_64 or arm64)."
    ;;
esac

ok "Detected $PLATFORM $ARCH"

# ---------------------------------------------------------------------------
# Node 24+ check; install via nvm if missing or too old
# ---------------------------------------------------------------------------

needs_node_install=0
current_node="(none)"

if command -v node >/dev/null 2>&1; then
  current_node="$(node --version 2>/dev/null | sed 's/^v//')"
  major="${current_node%%.*}"
  if [ -n "$major" ] && [ "$major" -ge "$REQUIRED_NODE_MAJOR" ] 2>/dev/null; then
    ok "Node $current_node is already installed"
  else
    note "Node $current_node is too old (need ≥ $REQUIRED_NODE_MAJOR). Installing $REQUIRED_NODE_MAJOR via nvm..."
    needs_node_install=1
  fi
else
  note "Node not found. Installing $REQUIRED_NODE_MAJOR via nvm..."
  needs_node_install=1
fi

if [ "$needs_node_install" = "1" ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    note "Installing nvm $NVM_VERSION..."
    if ! curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | bash >/dev/null 2>&1; then
      die "Failed to install nvm. Check your network or install Node 24+ manually: https://nodejs.org/"
    fi
    ok "Installed nvm $NVM_VERSION"
  fi

  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"

  if ! nvm install "$REQUIRED_NODE_MAJOR" >/dev/null 2>&1; then
    die "Failed to install Node $REQUIRED_NODE_MAJOR via nvm."
  fi
  nvm alias default "$REQUIRED_NODE_MAJOR" >/dev/null 2>&1 || true
  nvm use "$REQUIRED_NODE_MAJOR" >/dev/null 2>&1
  ok "Installed Node $(node --version)"
fi

# ---------------------------------------------------------------------------
# npm install
# ---------------------------------------------------------------------------

if ! command -v npm >/dev/null 2>&1; then
  die "npm not on PATH after Node install. Open a new terminal and re-run this installer."
fi

note "Installing $PACKAGE@$PIN_VERSION..."

# Verify npm prefix is writable; if not, fall back to user prefix.
npm_prefix="$(npm config get prefix 2>/dev/null || echo /usr/local)"
if [ ! -w "$npm_prefix" ] && [ "${needs_node_install}" = "0" ]; then
  warn "npm prefix $npm_prefix is not writable. Configuring user-local prefix at \$HOME/.npm-global..."
  npm config set prefix "$HOME/.npm-global"
  export PATH="$HOME/.npm-global/bin:$PATH"
  cat <<EOF >&2

To make this permanent, add to your shell rc:
  export PATH="\$HOME/.npm-global/bin:\$PATH"

EOF
fi

if ! npm install -g "${PACKAGE}@${PIN_VERSION}" >/tmp/ethos-install.log 2>&1; then
  warn "Install failed. Output:"
  cat /tmp/ethos-install.log >&2
  die "npm install failed. See output above."
fi

# Confirm the binary is on PATH
if ! command -v ethos >/dev/null 2>&1; then
  warn "ethos installed but not on PATH. You may need to open a new terminal or update your shell rc."
  warn "If you're using nvm, run: \\. \"\$NVM_DIR/nvm.sh\" && nvm use $REQUIRED_NODE_MAJOR"
fi

installed_version="$(ethos --version 2>/dev/null || echo "$PACKAGE@$PIN_VERSION")"
ok "Installed $installed_version"

# ---------------------------------------------------------------------------
# Post-install
# ---------------------------------------------------------------------------

say ""
ok "Ethos is ready. Try:"
say "    ethos setup     # one-time wizard: provider + key + personality"
say "    ethos chat      # start the REPL"
say "    ethos --help    # see all commands"
say ""

if [ "$RUN_SETUP" = "1" ]; then
  say "Running \`ethos setup\`..."
  say ""
  exec ethos setup
fi
