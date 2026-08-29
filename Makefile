NVM_INSTALLED    := $(shell test -f "$(HOME)/.nvm/nvm.sh"; echo $$?)
NODE_VERSION     := $(shell cat .nvmrc 2>/dev/null || echo 22)
PNPM_VERSION     := 10.33.0
ELECTRON_VERSION := $(shell ls node_modules/.pnpm/ 2>/dev/null | grep '^electron@[0-9]' | head -1 | sed 's/electron@//;s/_.*//')

# Source nvm and select the project's node version automatically. Every
# target that runs node/pnpm prefixes its command with $(NVM_EXEC), so
# devs never have to remember `nvm use`. Short-circuits to a no-op in
# two cases:
#   - $(CI) is set (GitHub Actions, CircleCI, etc. — Node is already on
#     PATH via actions/setup-node or equivalent).
#   - nvm.sh isn't present locally (assume Node is already on PATH some
#     other way; trust the user's setup).
NVM_EXEC = $(if $(CI),,$(if $(wildcard $(HOME)/.nvm/nvm.sh),. $(HOME)/.nvm/nvm.sh && nvm use >/dev/null &&,))

# Single source of truth for the release version.
# Never edit package.json versions directly — use make version-set or make version-bump-*.
VERSION := $(shell cat VERSION 2>/dev/null | tr -d '[:space:]')

.DEFAULT_GOAL := help

help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Setup"
	@echo "  setup              - Install nvm, node ($(NODE_VERSION)), pnpm ($(PNPM_VERSION)), and gstack"
	@echo "  setup-nvm          - Install nvm if missing"
	@echo "  setup-node         - Install the node version pinned in .nvmrc"
	@echo "  setup-pnpm         - Install pnpm globally"
	@echo "  setup-gstack       - Install/update gstack Claude Code skills"
	@echo "  prepare            - pnpm install (frozen lockfile)"
	@echo ""
	@echo "Development"
	@echo "  dev                - Start ethos in interactive chat mode (TUI when TTY)"
	@echo "  tui                - Alias for dev (explicit TUI entry point)"
	@echo "  desktop-dev        - Electron dev"
	@echo "  desktop-build      - Build + package macOS app to apps/desktop/dist-electron/"
	@echo "  web-dev               - Web UI dev: Vite HMR :5173 + ethos serve :3000 (recommended for active development)"
	@echo "  web-build             - Build the SPA to apps/web/dist"
	@echo "  web                   - Build SPA + run ethos serve with mounted static (single port :3000)"
	@echo "  gateway-setup         - Configure Telegram bot token"
	@echo "  gateway               - Start the Telegram gateway in foreground (dev)"
	@echo "  boot                  - Merged gateway+serve single-process boot profile (plan/phases/single-process-boot-profile.md)"
	@echo "  listen                - Start the wake-word satellite, capturing from the mic (DEVICE=<id> to pick one)"
	@echo "  listen-devices        - List this host's audio input devices (for DEVICE=)"
	@echo "  listen-doctor         - Preflight the wake stack (engine, models, mic, server)"
	@echo "  cron                  - Manage cron jobs (list|create|pause|resume|delete|run)"
	@echo "  personality           - Manage personalities (list | set <id>)"
	@echo "  memory                - View or clear memory (show | clear)"
	@echo "  keys                  - Manage API key rotation pool (list | add <key> | remove <n>)"
	@echo "  start-gateway-daemon  - Start gateway as a PM2 daemon (auto-restarts on crash)"
	@echo "  stop-gateway-daemon   - Stop the PM2 daemon (keeps it registered for reboot)"
	@echo "  delete-gateway-daemon - Remove from PM2 completely (no auto-restart ever)"
	@echo "  status-gateway-daemon - Show current daemon status and recent logs"
	@echo ""
	@echo "Docs"
	@echo "  docs               - Start docs dev server (localhost:3000)"
	@echo "  docs-build         - Build docs site for production"
	@echo ""
	@echo "Quality"
	@echo "  test               - Run unit tests (vitest run)"
	@echo "  typecheck          - tsc --noEmit across the workspace"
	@echo "  lint               - biome check"
	@echo "  format             - biome format --write"
	@echo "  version-sync       - run scripts/check-version-sync.sh (G1 + G2)"
	@echo "  bundle-deps        - run scripts/check-bundle-deps.sh (CLI bundle deps declared)"
	@echo "  check              - typecheck + tests + version-sync + bundle-deps (blocking) + lint (advisory) — mirrors CI"
	@echo ""
	@echo "Versioning (VERSION file is the single source of truth — never edit package.json directly)"
	@echo "  version            - Print current version"
	@echo "  version-set        - Set version: make version-set NEW=1.2.3"
	@echo "  version-bump-patch - 0.2.5 → 0.2.6, sync all package.json"
	@echo "  version-bump-minor - 0.2.5 → 0.3.0, sync all package.json"
	@echo "  version-bump-major - 0.2.5 → 1.0.0, sync all package.json"
	@echo ""
	@echo "Release (channel: npm only)"
	@echo "  verify             - Run pre-flight gates G1-G7 (G8 skipped locally)"
	@echo "  build-npm          - Build CLI binary: tsup → apps/ethos/dist/"
	@echo "  build-publishable  - Build all seven public packages to dist/"
	@echo "  release            - Full release: verify → tag → push (triggers CI)"
	@echo "  release-dry        - Show what release would do; no side effects"
	@echo "  release-npm        - Publish all seven packages to npm (used by CI + recovery)"
	@echo "  smoke              - Post-publish smoke test (alias for smoke-npm)"
	@echo "  smoke-npm          - Verify all seven packages are live on npm at VERSION"
	@echo ""
	@echo "Housekeeping"
	@echo "  clean              - Remove node_modules and dist output"
	@echo "  help               - Print this help"

# ---------- setup ----------

setup: setup-nvm setup-node setup-pnpm setup-gstack
	@echo "Setup complete. Next: make prepare"

setup-nvm:
	@echo "Checking if nvm is installed..."
	@if [ $(NVM_INSTALLED) -eq 0 ]; then \
		echo "  nvm already installed."; \
	else \
		echo "  installing nvm..."; \
		curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash; \
	fi

setup-gstack:
	@echo "Installing gstack Claude Code skills..."
	@if [ -d "$(HOME)/.claude/skills/gstack/.git" ]; then \
		echo "  updating existing gstack install..."; \
		git -C $(HOME)/.claude/skills/gstack pull --depth 1; \
	else \
		echo "  cloning gstack..."; \
		mkdir -p $(HOME)/.claude/skills && \
		git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git $(HOME)/.claude/skills/gstack; \
	fi
	@echo "  running setup..."
	@cd $(HOME)/.claude/skills/gstack && ./setup
	@echo "gstack installed. Skills available in Claude Code."

setup-node:
	@echo "Installing node $(NODE_VERSION) via nvm..."
	@. $(HOME)/.nvm/nvm.sh && nvm install $(NODE_VERSION) && nvm use $(NODE_VERSION)
	@echo "Node setup complete."

setup-pnpm:
	@echo "Installing pnpm@$(PNPM_VERSION)..."
	@. $(HOME)/.nvm/nvm.sh && nvm use >/dev/null && npm install -g pnpm@$(PNPM_VERSION)
	@echo "pnpm setup complete."

prepare:
	@echo "Installing dependencies..."
	@$(NVM_EXEC) pnpm install --frozen-lockfile
	@echo "Installing git hooks via lefthook..."
	@$(NVM_EXEC) pnpm dlx lefthook install >/dev/null 2>&1 || echo "  (lefthook install skipped; not in a git repo)"
	@echo "Dependencies installed."

# ---------- desktop ----------

desktop-dev: web-build
	@echo "Starting Electron dev (renderer at http://localhost:5173/)..."
	@$(NVM_EXEC) pnpm --filter @ethosagent/desktop dev

# Builds the Vite bundles then packages a macOS .app + .zip via electron-builder.
# Skips code signing for local builds (set CSC_* env vars to enable signing).
# After the build: open apps/desktop/dist-electron/mac-arm64/Ethos.app
desktop-build: web-build
	@echo "Building desktop app..."
	@CSC_IDENTITY_AUTO_DISCOVERY=false $(NVM_EXEC) pnpm --filter @ethosagent/desktop build
	@echo "Packaging macOS app..."
	@CSC_IDENTITY_AUTO_DISCOVERY=false $(NVM_EXEC) pnpm --filter @ethosagent/desktop package
	@echo "Done. Open: apps/desktop/dist-electron/mac-arm64/Ethos.app"

# ---------- dev ----------

dev:
	@$(NVM_EXEC) pnpm dev

tui: dev

# ---------- web UI ----------
#
# Two run modes:
#  • web-dev — active development. Vite at :5173 (HMR + source maps), ethos
#    serve at :3000. Vite proxies /rpc, /sse, /auth to :3000 so the browser
#    sees same-origin and the auth cookie stays scoped. Open the printed
#    `/auth/exchange?t=...` URL on :3000 once to set the cookie, then use
#    http://localhost:5173/ for the actual UI.
#  • web — production-like single port. Builds the SPA, mounts it via Hono
#    in `ethos serve`. Browser hits :3000 only. Use this to test what
#    real users will experience.
#
# WEB_PORT and ACP_PORT are overridable via env if 3000/3001 are taken.

WEB_PORT ?= 3000
ACP_PORT ?= 3001
VITE_PORT ?= 5173

web-build:
	@$(NVM_EXEC) pnpm build:web

# Parallel: kill both child processes when Make exits (Ctrl-C, error, etc).
# `trap 'kill 0' EXIT` sends SIGTERM to every process in the same group so
# neither orphan survives.
#
# Auth handshake nuance: Chrome partitions cookies between localhost ports
# in some configurations, so the auth-exchange URL MUST be opened on :$(VITE_PORT)
# (Vite proxies it to :$(WEB_PORT)). The token itself comes from `ethos serve`'s
# banner — copy the `?t=<token>` value, paste it after `localhost:$(VITE_PORT)/auth/exchange`.
web-dev:
	@echo "Starting web dev stack..."
	@echo "  Vite (HMR):   http://localhost:$(VITE_PORT)/"
	@echo "  ethos serve:  http://localhost:$(WEB_PORT)/  (token printed in startup banner below)"
	@echo "  ACP server:   http://localhost:$(ACP_PORT)/"
	@echo ""
	@echo "AUTH:  Visit http://localhost:$(VITE_PORT)/auth/exchange?t=<TOKEN>"
	@echo "       (NOT :$(WEB_PORT) — Chrome scopes cookies per port. Use :$(VITE_PORT) so"
	@echo "        the cookie is stored for the SPA's origin.)"
	@echo "       Copy <TOKEN> from the 'open: http://localhost:$(WEB_PORT)/...' line below."
	@echo ""
	@$(NVM_EXEC) bash -c '\
		trap "kill 0" EXIT INT TERM; \
		pnpm exec tsx apps/ethos/src/index.ts serve --port $(ACP_PORT) --web-port $(WEB_PORT) & \
		pnpm --filter @ethosagent/web dev -- --port $(VITE_PORT) --strictPort & \
		wait \
	'

# Production-like — build first so the static handler has dist to serve.
web: web-build
	@echo "Web UI bundled — starting ethos serve at http://localhost:$(WEB_PORT)/"
	@$(NVM_EXEC) pnpm exec tsx apps/ethos/src/index.ts serve --port $(ACP_PORT) --web-port $(WEB_PORT)

gateway-setup:
	@$(NVM_EXEC) pnpm exec tsx apps/ethos/src/index.ts gateway setup

gateway:
	@$(NVM_EXEC) pnpm exec tsx apps/ethos/src/index.ts gateway start

# Merged gateway+serve single-process boot profile (plan/phases/single-process-boot-profile.md).
# Does not wire SIP, dreaming, the Langfuse poller, kanban polling, or team-supervisor spawning — those still need `gateway start`/`serve` individually.
boot:
	@$(NVM_EXEC) pnpm exec tsx apps/ethos/src/index.ts boot --port $(ACP_PORT) --web-port $(WEB_PORT)

# ---------- wake satellite ----------
#
# `ethos listen` reads raw s16le mono 16 kHz PCM from STDIN — there is no native
# microphone binding, deliberately (apps/ethos/src/lib/stdin-pcm-device.ts: a
# per-arch native module would break the daemon on exactly the Pi/server hosts it
# was written for). The pipe IS the device.
#
# That is the CLI's contract, not this target's. `make listen` builds the capture
# half for you — a `make` target whose whole job is "try this feature" cannot ask
# you to hand-assemble an ffmpeg line and get a device index right first try. The
# raw form stays supported and is what a Pi with unusual hardware should use:
#
#   <your capture> | pnpm exec tsx apps/ethos/src/index.ts listen
#
# `-nostats -loglevel error` is not decoration. Both processes share the
# terminal, and ffmpeg writes a carriage-returned progress line to stderr that
# overwrites the daemon's own output mid-line ("› you: hello7.9kbits/s speed=
# 1x"). `-loglevel error` drops the banner and the meter; `-nostats` is what
# keeps the meter gone on builds that print it regardless of log level. Real
# errors — bad device index, no permission — still print. arecord's `-q` does
# the same for its one banner line; it has no meter to silence.

# Fixed by the daemon's contract: s16le, mono, at this rate. Raw PCM carries no
# header, so a mismatch here is silent garbage rather than an error — which is
# why the rate is stated once and derived everywhere, never re-typed.
LISTEN_RATE := 16000

# Which input to capture from. `default` means "whatever the OS calls the system
# default input" on BOTH platforms — avfoundation's `:default` pseudo-device and
# ALSA's `default` PCM — and that is deliberately not an index. Indices SHIFT:
# unplug a USB headset and the `:2` you memorised stops existing while `:1`
# silently becomes the built-in mic. An index baked into this file is wrong the
# first time the hardware moves, and the failure lands as an ffmpeg error buried
# above an otherwise-clean preflight. Override after checking `make listen-devices`:
#
#   DEVICE=1 make listen         (macOS: avfoundation audio device index)
#   DEVICE=hw:1,0 make listen    (Linux: ALSA device name)
DEVICE ?= default

# `ethos listen doctor` reuses the repo's three-way exit contract verbatim (see
# `computeDoctorExit` in apps/ethos/src/commands/doctor.ts, and ListenFailFlags
# in apps/ethos/src/commands/listen.ts):
#   0 - everything passes
#   1 - something is genuinely broken on this host (bad config, missing wake
#       model, engine that won't load) — a human has to fix it
#   2 - nothing is broken, but a dependency simply isn't up right now (server
#       down, no mic piped in) — recoverable, and the point of the contract is
#       letting CI tell this apart from a 1
# Make treats every nonzero status as a build failure, so without translating
# here a warn-level run prints "Nothing is broken on this host" and then
# `make: *** [listen-doctor] Error 2` — the two lines contradict each other.
# So exit 2 passes at the make level; exit 1 still fails the build. Do not
# "simplify" this back to a bare command.
listen-doctor:
	@$(NVM_EXEC) pnpm exec tsx apps/ethos/src/index.ts listen doctor $(ARGS); \
		status=$$?; \
		if [ $$status -eq 2 ]; then exit 0; fi; \
		exit $$status

# The device list, platform-aware. This is what you need the moment the default
# input is the wrong one, and until now it existed only inside an error message.
#
# avfoundation has no "just list them" mode: `-list_devices true` needs an `-i`
# it then refuses to open, so the command ALWAYS exits non-zero and writes the
# list to stderr. Hence `|| true` and the 2>&1 — the nonzero status here means
# nothing. The sed strips the `[AVFoundation indev @ 0x...] ` prefix off every
# line; if it matches nothing, the raw output is printed instead so a genuine
# ffmpeg failure is never swallowed by a filter that expected it to succeed.
listen-devices:
	@bash -c 'case "$$(uname -s)" in \
	    Darwin) \
	      command -v ffmpeg >/dev/null 2>&1 || { echo "listen-devices needs ffmpeg on macOS. Install: brew install ffmpeg" >&2; exit 1; }; \
	      out=$$(ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 || true); \
	      rows=$$(printf "%s\n" "$$out" | sed -n "s/^\[AVFoundation indev @ [^]]*\] //p"); \
	      if [ -n "$$rows" ]; then printf "%s\n" "$$rows"; else printf "%s\n" "$$out"; fi; \
	      echo ""; \
	      echo "Capture from one with: DEVICE=<audio index> make listen   (default: the system default input)" ;; \
	    Linux) \
	      command -v arecord >/dev/null 2>&1 || { echo "listen-devices needs arecord on Linux. Install: apt install alsa-utils" >&2; exit 1; }; \
	      arecord -l; \
	      echo ""; \
	      echo "Capture from one with: DEVICE=hw:<card>,<device> make listen   (default: the ALSA default PCM)" ;; \
	    *) echo "listen-devices only knows macOS (ffmpeg) and Linux (arecord); this host reports $$(uname -s)." >&2; exit 1 ;; \
	  esac'

# Capture + daemon, one pipeline.
#
# `set -o pipefail` is load-bearing: without it the pipeline reports only the
# daemon's status, and a capture command that died on a bad device would be
# masked by whatever the daemon happened to exit with. Both halves already
# agree in the common case — a dead capture closes the pipe, and the daemon
# exits 1 when the pipe closes having carried zero frames (CAPTURE_ENDED_EXIT
# in apps/ethos/src/commands/listen.ts) — but that agreement is the daemon's
# behaviour to change, not something this target should depend on.
#
# No `trap "kill 0"` here, unlike web-dev. That target runs two INDEPENDENT
# background processes and must reap them by hand; this is a single foreground
# pipeline, so the shell does not return until both members have exited, and a
# capture still running after the daemon dies is killed by SIGPIPE on its next
# write (which, at $(LISTEN_RATE) Hz, is immediate). Ctrl+C reaches every member
# directly — they share make's process group.
#
# 130 (128 + SIGINT) maps to 0 for the same reason listen-doctor maps 2 to 0:
# Ctrl+C is how this target is SUPPOSED to end. The daemon handles SIGINT,
# prints "Shutting down..." and exits 0 (listen.ts registers `shutdown(0)`), but
# the interrupted capture reports 130 and pipefail forwards it — so make would
# stamp "*** [listen] Error 130" directly under a clean shutdown message. Only
# 130 is translated; nothing in this pipeline produces it except a signal.
listen:
	@$(NVM_EXEC) bash -c 'set -o pipefail; \
	  case "$$(uname -s)" in \
	    Darwin) \
	      command -v ffmpeg >/dev/null 2>&1 || { echo "make listen captures the mic with ffmpeg on macOS, and ffmpeg is not on PATH. Install it (brew install ffmpeg), or pipe your own s16le/mono/$(LISTEN_RATE) capture into: pnpm exec tsx apps/ethos/src/index.ts listen" >&2; exit 1; }; \
	      if [ "$(DEVICE)" = default ]; then \
	        desc="the macOS system default input (avfoundation :default)"; \
	      else \
	        name=$$(ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 | sed -n "/audio devices:/,\$$p" | sed -n "s/.*\[$(DEVICE)\] //p" | head -1); \
	        desc="avfoundation :$(DEVICE) — $${name:-NO SUCH AUDIO DEVICE INDEX on this host; run make listen-devices}"; \
	      fi; \
	      capture="ffmpeg -nostats -loglevel error -f avfoundation -i :$(DEVICE) -ar $(LISTEN_RATE) -ac 1 -f s16le -" ;; \
	    Linux) \
	      command -v arecord >/dev/null 2>&1 || { echo "make listen captures the mic with arecord on Linux, and arecord is not on PATH. Install it (apt install alsa-utils), or pipe your own s16le/mono/$(LISTEN_RATE) capture into: pnpm exec tsx apps/ethos/src/index.ts listen" >&2; exit 1; }; \
	      desc="ALSA device $(DEVICE)"; \
	      capture="arecord -q -D $(DEVICE) -f S16_LE -r $(LISTEN_RATE) -c 1 -t raw" ;; \
	    *) echo "make listen can only build a capture pipeline on macOS (ffmpeg) or Linux (arecord); this host reports $$(uname -s). Pipe your own s16le/mono/$(LISTEN_RATE) PCM into: pnpm exec tsx apps/ethos/src/index.ts listen" >&2; exit 1 ;; \
	  esac; \
	  echo "Microphone: $$desc"; \
	  echo "            override with DEVICE=<id> make listen; see make listen-devices"; \
	  echo ""; \
	  $$capture | pnpm exec tsx apps/ethos/src/index.ts listen $(ARGS); \
	  status=$$?; \
	  if [ $$status -eq 130 ]; then exit 0; fi; \
	  exit $$status'

cron:
	@$(NVM_EXEC) pnpm exec tsx apps/ethos/src/index.ts cron $(ARGS)

personality:
	@$(NVM_EXEC) pnpm exec tsx apps/ethos/src/index.ts personality $(ARGS)

memory:
	@$(NVM_EXEC) pnpm exec tsx apps/ethos/src/index.ts memory $(ARGS)

keys:
	@$(NVM_EXEC) pnpm exec tsx apps/ethos/src/index.ts keys $(ARGS)

# ---------- gateway daemon (PM2) ----------

GATEWAY_NAME := ethos-gateway
GATEWAY_CMD  := pnpm exec tsx apps/ethos/src/index.ts gateway start

start-gateway-daemon:
	@echo ""
	@echo "This will start the Ethos gateway as a persistent background daemon."
	@echo "PM2 will automatically restart it if it crashes or if the machine reboots."
	@echo ""
	@printf "Are you sure you want to start the gateway daemon? [y/N] "; \
	read answer; \
	if [ "$$answer" = "y" ] || [ "$$answer" = "Y" ]; then \
		echo ""; \
		$(NVM_EXEC) pm2 describe $(GATEWAY_NAME) >/dev/null 2>&1 \
			&& $(NVM_EXEC) pm2 restart $(GATEWAY_NAME) \
			|| $(NVM_EXEC) pm2 start "$(GATEWAY_CMD)" \
			     --name $(GATEWAY_NAME) \
			     --cwd $(CURDIR) \
			     --log ~/.ethos/logs/gateway.log \
			     --time; \
		$(NVM_EXEC) pm2 save; \
		echo ""; \
		echo "  ✓ Gateway daemon started."; \
		echo "  Logs: pm2 logs $(GATEWAY_NAME)"; \
		echo "  Stop: make stop-gateway-daemon"; \
	else \
		echo "Aborted."; \
	fi

stop-gateway-daemon:
	@echo ""
	@echo "This will stop the gateway daemon."
	@echo "It will NOT restart on crash, but WILL restart on machine reboot."
	@echo "Use 'make delete-gateway-daemon' to remove it completely."
	@echo ""
	@printf "Are you sure you want to stop the gateway daemon? [y/N] "; \
	read answer; \
	if [ "$$answer" = "y" ] || [ "$$answer" = "Y" ]; then \
		$(NVM_EXEC) pm2 stop $(GATEWAY_NAME) && $(NVM_EXEC) pm2 save; \
		echo "  ✓ Gateway daemon stopped."; \
	else \
		echo "Aborted."; \
	fi

delete-gateway-daemon:
	@echo ""
	@echo "WARNING: This will permanently remove the gateway daemon from PM2."
	@echo "It will NOT restart on crash or on machine reboot."
	@echo ""
	@printf "Are you sure you want to delete the gateway daemon? [y/N] "; \
	read answer; \
	if [ "$$answer" = "y" ] || [ "$$answer" = "Y" ]; then \
		$(NVM_EXEC) pm2 delete $(GATEWAY_NAME) && $(NVM_EXEC) pm2 save; \
		echo "  ✓ Gateway daemon deleted."; \
	else \
		echo "Aborted."; \
	fi

status-gateway-daemon:
	@echo ""
	@echo "=== Gateway daemon status ==="
	@$(NVM_EXEC) pm2 describe $(GATEWAY_NAME) 2>/dev/null || echo "  Daemon not found. Run: make start-gateway-daemon"
	@echo ""
	@echo "=== Recent logs (last 20 lines) ==="
	@$(NVM_EXEC) pm2 logs $(GATEWAY_NAME) --lines 20 --nostream 2>/dev/null || true

# ---------- docs ----------

docs:
	@$(NVM_EXEC) pnpm --filter docs run start

docs-build:
	@$(NVM_EXEC) pnpm --filter docs run build

# ---------- quality ----------
#
# Each target wraps the matching scripts/check-*.sh so make / CI / humans all
# run the same code path. CI's ci.yml jobs call the same scripts directly; the
# composite `check` target runs all five via scripts/run-checks.sh and mirrors
# CI's policy (typecheck + tests + version-sync + bundle-deps block; lint advisory).

test:
	@$(NVM_EXEC) bash scripts/check-tests.sh

typecheck:
	@$(NVM_EXEC) bash scripts/check-typecheck.sh

lint:
	@$(NVM_EXEC) bash scripts/check-lint.sh

version-sync:
	@$(NVM_EXEC) bash scripts/check-version-sync.sh

bundle-deps:
	@$(NVM_EXEC) bash scripts/check-bundle-deps.sh

format:
	@$(NVM_EXEC) pnpm format

# Mirrors CI exactly. Override LINT_BLOCKING=1 to make lint fail the run too.
check:
	@$(NVM_EXEC) bash scripts/run-checks.sh

# ---------- versioning (VERSION file is the single source of truth) ----------
#
# All workspace package.json version fields are derived from ./VERSION.
# make version-set / version-bump-* are the only correct ways to bump.
# Never edit package.json versions directly — the CI verify gate will catch it.

version:
	@cat VERSION

version-set:
	@if [ -z "$(NEW)" ]; then echo "Usage: make version-set NEW=1.2.3"; exit 1; fi
	@echo "$(NEW)" > VERSION
	@$(NVM_EXEC) node scripts/sync-version.js
	@echo "Version set to $(NEW)."

version-bump-patch:
	@$(NVM_EXEC) node -e " \
	  const fs = require('node:fs'); \
	  const v = fs.readFileSync('VERSION', 'utf8').trim().split('.'); \
	  v[2] = String(Number(v[2]) + 1); \
	  fs.writeFileSync('VERSION', v.join('.') + '\n'); \
	"
	@$(NVM_EXEC) node scripts/sync-version.js
	@echo "Bumped to $$(cat VERSION)."

version-bump-minor:
	@$(NVM_EXEC) node -e " \
	  const fs = require('node:fs'); \
	  const v = fs.readFileSync('VERSION', 'utf8').trim().split('.'); \
	  v[1] = String(Number(v[1]) + 1); v[2] = '0'; \
	  fs.writeFileSync('VERSION', v.join('.') + '\n'); \
	"
	@$(NVM_EXEC) node scripts/sync-version.js
	@echo "Bumped to $$(cat VERSION)."

version-bump-major:
	@$(NVM_EXEC) node -e " \
	  const fs = require('node:fs'); \
	  const v = fs.readFileSync('VERSION', 'utf8').trim().split('.'); \
	  v[0] = String(Number(v[0]) + 1); v[1] = '0'; v[2] = '0'; \
	  fs.writeFileSync('VERSION', v.join('.') + '\n'); \
	"
	@$(NVM_EXEC) node scripts/sync-version.js
	@echo "Bumped to $$(cat VERSION)."

# ---------- verification ----------

# Run all pre-flight gates (G1-G5, G7, G8-if-CI).
# G7 (tests green) is run here via pnpm check; G8 (NPM_TOKEN) runs only in CI.
verify:
	@echo "=== Pre-flight verification for v$(VERSION) ==="
	@$(NVM_EXEC) node scripts/verify-version.js
	@echo ""
	@echo "G7: typecheck + lint + test..."
	@$(MAKE) check
	@echo ""
	@echo "All gates passed — v$(VERSION) is ready to release."

# ---------- build ----------

# The seven public packages on npm. Publish order matters: lower-level packages
# must publish before consumers, so `pnpm publish` can resolve `workspace:*` to a
# real version range that exists on the registry.
#   types → core → plugin-contract → plugin-sdk → web-contracts → sdk → cli
# web-contracts must precede sdk (sdk depends on it).
PUBLISHABLE := packages/types packages/core packages/plugin-contract packages/plugin-sdk packages/web-contracts packages/sdk apps/ethos

PUBLISHABLE_FILTERS := --filter='./packages/types' \
                       --filter='./packages/core' \
                       --filter='./packages/plugin-contract' \
                       --filter='./packages/plugin-sdk' \
                       --filter='./packages/web-contracts' \
                       --filter='./packages/sdk' \
                       --filter='./apps/ethos'

# Build only the CLI binary (tsup → apps/ethos/dist/).
build-npm:
	@echo "Building CLI binary..."
	@$(NVM_EXEC) pnpm --filter '@ethosagent/cli' run build
	@echo "Build complete."

# Build all seven publishable packages.
build-publishable:
	@echo "Building all seven public packages..."
	@$(NVM_EXEC) pnpm -r $(PUBLISHABLE_FILTERS) run build
	@echo "Build complete."

# ---------- release ----------

# Full LOCAL release: verify (G1-G7) → build → publish → tag → push → smoke.
# Everything runs on your machine — no CI workflow involved.
# Bump version first: make version-bump-{patch,minor,major}
# Then commit: git commit -am "release: v$(make version)"
# Then: make release
#
# Order is publish-then-tag: if publish fails, no tag is pushed (no orphan tags
# pointing at versions that never shipped). release-npm is idempotent, so a
# partial-publish failure is recoverable by re-running `make release`.
release:
	@echo "Starting release for v$(VERSION)..."
	@$(MAKE) verify
	@echo ""
	@echo "Building publishable packages..."
	@$(MAKE) build-publishable
	@echo ""
	@echo "Publishing to npm..."
	@$(MAKE) release-npm
	@echo ""
	@echo "Tagging v$(VERSION) and pushing to origin..."
	@git tag "v$(VERSION)" && \
	git push origin main "v$(VERSION)" && \
	echo "" && \
	echo "Waiting 5s for npm registry propagation before smoke..." && \
	sleep 5 && \
	$(MAKE) smoke && \
	echo "" && \
	echo "✓ Released v$(VERSION). All seven packages live on npm."

# Show what make release would do without any side effects.
release-dry:
	@echo "=== Release dry run for v$(VERSION) ==="
	@echo ""
	@echo "Steps that would run (all local — no CI):"
	@echo "  1. make verify              — pre-flight gates G1-G7"
	@echo "  2. make build-publishable   — build all 7 packages"
	@echo "  3. make release-npm         — publish to npm (lockstep, idempotent)"
	@echo "  4. git tag v$(VERSION)"
	@echo "  5. git push origin main v$(VERSION)"
	@echo "  6. sleep 5 + make smoke     — fresh install + version check + LLM round-trip"
	@echo ""
	@echo "Packages that would publish:"
	@for dir in $(PUBLISHABLE); do \
		name=$$($(NVM_EXEC) node -p "require('./$$dir/package.json').name"); \
		local=$$($(NVM_EXEC) node -p "require('./$$dir/package.json').version"); \
		remote=$$(npm view "$$name" version 2>/dev/null || echo "unpublished"); \
		if [ "$$local" = "$$remote" ]; then \
			echo "  ✓  $$name@$$local — already on npm, would skip"; \
		else \
			echo "  →  $$name@$$local  (npm has: $$remote)  ← would publish"; \
		fi; \
	done

# Publish all seven packages to npm. Idempotent: skips packages already at the correct version.
# Used by the CI release workflow and for manual recovery.
# Requires: npm login, or NODE_AUTH_TOKEN / NPM_TOKEN set.
release-npm:
	@echo "Publishing packages for v$(VERSION)..."
	@for dir in $(PUBLISHABLE); do \
		name=$$($(NVM_EXEC) node -p "require('./$$dir/package.json').name"); \
		local=$$($(NVM_EXEC) node -p "require('./$$dir/package.json').version"); \
		remote=$$(npm view "$$name" version 2>/dev/null || echo "unpublished"); \
		if [ "$$local" = "$$remote" ]; then \
			echo "  ✓  $$name@$$local already on npm — skipping"; \
		else \
			echo "  →  Publishing $$name@$$local  (npm has: $$remote)"; \
			$(NVM_EXEC) pnpm --filter "$$name" publish --access public --no-git-checks; \
		fi; \
	done
	@echo "Done."

# ---------- smoke ----------

smoke: smoke-npm

smoke-npm:
	@echo "Smoke-checking 7 published packages for v$(VERSION)..."
	@failed=0; \
	for dir in $(PUBLISHABLE); do \
		name=$$($(NVM_EXEC) node -p "require('./$$dir/package.json').name"); \
		remote=$$(npm view "$$name@$(VERSION)" version 2>/dev/null || true); \
		if [ "$$remote" = "$(VERSION)" ]; then \
			echo "  ✓ $$name@$(VERSION)"; \
		else \
			echo "  ✗ $$name@$(VERSION) — npm reports: $${remote:-not published}"; \
			failed=1; \
		fi; \
	done; \
	if [ "$$failed" = "1" ]; then exit 1; fi
	@echo "All 7 packages verified on npm."

# ---------- housekeeping ----------

clean:
	@echo "Cleaning node_modules and build output..."
	@rm -rf node_modules
	@find . -name 'dist' -not -path '*/node_modules/*' -exec rm -rf {} + 2>/dev/null; true
	@echo "Clean complete."

.PHONY: help setup setup-nvm setup-node setup-pnpm setup-gstack prepare \
        dev tui web web-dev web-build gateway-setup gateway boot \
        listen listen-devices listen-doctor \
        cron personality memory keys \
        start-gateway-daemon stop-gateway-daemon delete-gateway-daemon status-gateway-daemon \
        docs docs-build \
        test typecheck lint version-sync format check \
        version version-set version-bump-patch version-bump-minor version-bump-major \
        verify \
        build-npm build-publishable \
        release release-dry release-npm \
        smoke smoke-npm \
        clean
