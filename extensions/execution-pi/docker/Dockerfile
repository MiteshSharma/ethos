# The image a Pi run's container is built from.
#
# Build and pin it yourself — `buildKeepAliveArgs` refuses any image reference
# that is not digest-pinned (`@sha256:`), which is the same rule every other
# sandboxed execution path follows. Tag, push to a registry you control, and put
# the resulting digest in `background.pi_image`:
#
#   docker build -t <registry>/ethos-pi:<v> extensions/execution-pi/docker
#   docker push  <registry>/ethos-pi:<v>
#   docker image inspect --format '{{index .RepoDigests 0}}' <registry>/ethos-pi:<v>
#
# NOTE: no ENTRYPOINT. The container is started as a keep-alive `sleep infinity`
# and the host attaches with `docker exec`; an ENTRYPOINT of `pi` would swallow
# that command line.
FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

# Pinned to the version the Phase 0 spike validated the RPC protocol against.
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.2

WORKDIR /workspace
