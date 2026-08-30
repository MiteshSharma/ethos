# Stage 1: install — build tools for native modules (argon2)
# Pinned 2026-08-06: node:24.19.0 SIGBUSes the gateway at boot (suspected
# node:sqlite mmap regression; last good 24.18.0). Minor-patch pin so 24.18.x
# security patches still flow. Revisit when a fixed 24.x lands.
FROM node:24.18-slim AS install

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# --omit=dev: skip devDependencies that contain workspace-private "0.0.0"
# refs (e.g. @ethosagent/safety-redact, @ethosagent/secrets-aws). Those
# packages are bundled into cli/dist via tsup noExternal, but pnpm's publish
# rewrites workspace:* → 0.0.0 in the manifest. Without this flag, npm
# install nests every transitive dep inside cli/node_modules/ instead of
# hoisting to /usr/local/lib/node_modules/, which then breaks Node ESM
# resolution at runtime ("Cannot find package @ethosagent/types").
# No working default — a stale pinned default drifted two minors behind the
# released VERSION once already. CI passes the released version explicitly:
#   docker build --build-arg CLI_VERSION=$(cat VERSION) docker/
ARG CLI_VERSION
RUN test -n "${CLI_VERSION}" || { echo "CLI_VERSION build-arg is required (e.g. --build-arg CLI_VERSION=\$(cat VERSION))" >&2; exit 1; }
RUN npm install -g --omit=dev @ethosagent/cli@${CLI_VERSION}
RUN npm install -g argon2@^0.43.0

# Stage 2: runtime — clean production image
# Pinned to 24.18 — see note above the install stage.
FROM node:24.18-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

RUN userdel -r node && useradd -m -u 1000 ethos

COPY --from=install /usr/local/lib/node_modules /usr/local/lib/node_modules
# Recreate the bin symlink — Docker's COPY dereferences single-file
# symlinks, so copying /usr/local/bin/ethos directly would land a 1.9MB
# regular file in /usr/local/bin/, breaking Node ESM module resolution
# (the file is no longer under @ethosagent/cli/, so node_modules/ walking
# fails to find @ethosagent/types at runtime).
RUN ln -sf /usr/local/lib/node_modules/@ethosagent/cli/dist/index.js /usr/local/bin/ethos

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY docker-healthcheck.sh /usr/local/bin/docker-healthcheck.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/docker-healthcheck.sh

# A personality's default fs_reach grants write on [ownDir, cwd]. Created and
# chowned before dropping privileges so the unprivileged runtime user can write
# there; WORKDIR points at it so `process.cwd()` lands on a mounted, persistent
# path instead of the (read-only, in compose) root filesystem.
RUN mkdir -p /home/ethos/workspace && chown ethos:ethos /home/ethos/workspace

USER ethos
WORKDIR /home/ethos/workspace

VOLUME /home/ethos/.ethos
VOLUME /home/ethos/workspace
EXPOSE 3000

# Mode-aware: probes :3000 for ui/all, :3002 for gateway — a hardcoded :3000
# curl could never pass for ETHOS_MODE=gateway (nothing listens there).
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD docker-healthcheck.sh

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["boot"]
