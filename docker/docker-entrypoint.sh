#!/bin/sh
set -e

# Single-service profile provisions config from env at boot (W1.3). The CLI
# `ethos setup --from-env` is idempotent by contract: config.yaml is written
# once (skip-if-exists), secrets re-sync from env every boot, and it emits the
# init last-line contract (✓ on success / an actionable error before a
# non-zero exit). The three-service topology provisions via a dedicated `init`
# service instead and leaves ETHOS_PROVISION_FROM_ENV unset.
if [ "${ETHOS_PROVISION_FROM_ENV:-0}" = "1" ]; then
  ethos setup --from-env
fi

# `boot` is the merged single-process profile: gateway role + serve role in ONE
# process, so boot-time reconciliation runs in full on every start
# (plan/phases/single-process-boot-profile.md). `all` still spawns two
# subprocesses and keeps the crash isolation between them; `boot` trades that
# isolation for one cold boot and complete reconciliation, which is the right
# call for a single-tenant scale-to-zero microVM and the wrong one for a
# shared always-on host.
case "${ETHOS_MODE:-all}" in
  all)     exec ethos run-all "$@" ;;
  gateway) exec ethos gateway start "$@" ;;
  ui)      exec ethos serve "$@" ;;
  boot)    exec ethos boot "$@" ;;
  *)       echo "Unknown ETHOS_MODE: $ETHOS_MODE (valid: all, gateway, ui, boot)" >&2; exit 1 ;;
esac
