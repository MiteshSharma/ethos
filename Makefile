NVM_INSTALLED := $(shell test -f "$(HOME)/.nvm/nvm.sh"; echo $$?)
NODE_VERSION  := $(shell cat .nvmrc 2>/dev/null || echo 22)
PNPM_VERSION  := 10.33.0

# Every target that runs node/pnpm sources nvm and selects the project's node
# version, so you never have to remember `nvm use` yourself.
NVM_EXEC = . $(HOME)/.nvm/nvm.sh && nvm use >/dev/null &&

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
	@echo "  gateway-setup         - Configure Telegram bot token"
	@echo "  gateway               - Start the Telegram gateway in foreground (dev)"
	@echo "  cron                  - Manage cron jobs (list|create|pause|resume|delete|run)"
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
	@echo "  check              - typecheck + lint + test (full CI suite locally)"
	@echo ""
	@echo "Publishing"
	@echo "  build-sdk          - Build all publishable packages to dist/"
	@echo "  publish            - Build + publish packages whose local version > npm version"
	@echo "  publish-dry        - Show what would be published without publishing"
	@echo "  version-patch      - Bump patch version (0.1.0 → 0.1.1) on all publishable packages"
	@echo "  version-minor      - Bump minor version (0.1.0 → 0.2.0) on all publishable packages"
	@echo "  version-major      - Bump major version (0.1.0 → 1.0.0) on all publishable packages"
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
	@echo "Rebuilding native modules for current Node version..."
	@$(NVM_EXEC) npm rebuild better-sqlite3
	@echo "Dependencies installed."

# ---------- dev ----------

dev:
	@$(NVM_EXEC) pnpm dev

tui: dev

gateway-setup:
	@$(NVM_EXEC) pnpm exec tsx apps/ethos/src/index.ts gateway setup

gateway:
	@$(NVM_EXEC) pnpm exec tsx apps/ethos/src/index.ts gateway start

cron:
	@$(NVM_EXEC) pnpm exec tsx apps/ethos/src/index.ts cron $(ARGS)

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

test:
	@$(NVM_EXEC) pnpm test

typecheck:
	@$(NVM_EXEC) pnpm typecheck

lint:
	@$(NVM_EXEC) pnpm lint

format:
	@$(NVM_EXEC) pnpm format

check: typecheck lint test

# ---------- publishing ----------

# Packages exported to npm so external plugin authors can build without monorepo access.
# Publish order matters: types → core → plugin-contract → plugin-sdk
PUBLISHABLE := packages/types packages/core packages/plugin-contract packages/plugin-sdk

build-sdk:
	@echo "Building publishable packages..."
	@$(NVM_EXEC) pnpm -r --filter='./packages/types' \
	                    --filter='./packages/core' \
	                    --filter='./packages/plugin-contract' \
	                    --filter='./packages/plugin-sdk' \
	                    run build
	@echo "Build complete."

# Publish packages whose local version differs from the version on npm.
# Workspace deps (workspace:*) are automatically replaced with real versions by pnpm publish.
# Requires: npm login (or NPM_TOKEN env var for CI)
publish: build-sdk
	@echo "Checking and publishing packages..."
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

# Dry run — shows what would be published without actually publishing.
publish-dry: build-sdk
	@echo "Dry run — packages that would be published:"
	@for dir in $(PUBLISHABLE); do \
		name=$$($(NVM_EXEC) node -p "require('./$$dir/package.json').name"); \
		local=$$($(NVM_EXEC) node -p "require('./$$dir/package.json').version"); \
		remote=$$(npm view "$$name" version 2>/dev/null || echo "unpublished"); \
		if [ "$$local" = "$$remote" ]; then \
			echo "  ✓  $$name@$$local — up to date"; \
		else \
			echo "  →  $$name@$$local  (npm has: $$remote)  ← would publish"; \
		fi; \
	done

# Version bump targets — updates package.json version in all publishable packages.
# Run one of these, then commit, then make publish.
version-patch:
	@$(NVM_EXEC) pnpm -r --filter='./packages/types' \
	                    --filter='./packages/core' \
	                    --filter='./packages/plugin-contract' \
	                    --filter='./packages/plugin-sdk' \
	                    exec npm version patch --no-git-tag-version
	@echo "Patch versions bumped. Review changes, commit, then run: make publish"

version-minor:
	@$(NVM_EXEC) pnpm -r --filter='./packages/types' \
	                    --filter='./packages/core' \
	                    --filter='./packages/plugin-contract' \
	                    --filter='./packages/plugin-sdk' \
	                    exec npm version minor --no-git-tag-version
	@echo "Minor versions bumped. Review changes, commit, then run: make publish"

version-major:
	@$(NVM_EXEC) pnpm -r --filter='./packages/types' \
	                    --filter='./packages/core' \
	                    --filter='./packages/plugin-contract' \
	                    --filter='./packages/plugin-sdk' \
	                    exec npm version major --no-git-tag-version
	@echo "Major versions bumped. Review changes, commit, then run: make publish"

# ---------- housekeeping ----------

clean:
	@echo "Cleaning node_modules and build output..."
	@rm -rf node_modules
	@find . -name 'dist' -not -path '*/node_modules/*' -exec rm -rf {} + 2>/dev/null; true
	@echo "Clean complete."

.PHONY: help setup setup-nvm setup-node setup-pnpm setup-gstack prepare \
        dev tui gateway-setup gateway cron \
        start-gateway-daemon stop-gateway-daemon delete-gateway-daemon status-gateway-daemon \
        docs docs-build \
        test typecheck lint format check \
        build-sdk publish publish-dry version-patch version-minor version-major \
        clean
