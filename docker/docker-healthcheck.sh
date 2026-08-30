#!/bin/sh
# Mode-aware container healthcheck (W1.2, zero-friction-first-hour plan).
#
# One script baked into the image gives every consumer — compose services AND
# raw `docker run` users — the correct probe for their ETHOS_MODE:
#
#   ui / all → the web-api's :3000/healthz (serves onboarding mode too)
#   gateway  → the gateway's own :3002/healthz (ETHOS_GATEWAY_HEALTH_PORT),
#              which builds a live heartbeat per request — the same
#              buildGatewayHeartbeat machinery behind gateway-health.json,
#              not a second health mechanism.
#   boot     → the merged scale-to-zero single-process profile; binds its
#              health server on the same :3002/healthz (ETHOS_GATEWAY_HEALTH_PORT)
#              as gateway mode — same mechanism, not a second one.
#
# Liveness semantics (plan W1.2): only DEFINITIVE local failure flips the
# container unhealthy. Third-party unreachability (a Telegram outage, an
# adapter reporting not-ok) surfaces as HTTP 503 "degraded" from a live
# process — that stays HEALTHY, so an upstream blip never fails a fresh
# `compose up` boot. What exits unhealthy:
#   • no HTTP response at all — the process is dead or wedged
#   • in `all` mode, a gateway heartbeat that is stale or missing — the
#     supervised gateway child died while serve stayed up
#
# ETHOS_HEALTHCHECK_WEB_PORT exists for the test matrix only; inside the
# image the web-api always listens on 3000.

MODE="${ETHOS_MODE:-all}"

case "$MODE" in
  boot | gateway) PORT="${ETHOS_GATEWAY_HEALTH_PORT:-3002}" ;;
  ui | all) PORT="${ETHOS_HEALTHCHECK_WEB_PORT:-3000}" ;;
  *)
    echo "unknown ETHOS_MODE: $MODE (valid: all, boot, gateway, ui)" >&2
    exit 1
    ;;
esac

BODY="$(curl -s --max-time 5 "http://localhost:${PORT}/healthz")" || exit 1

if [ "$MODE" = "all" ]; then
  # The web-api's /healthz embeds the gateway heartbeat block:
  #   gateway.status: "ok" | "stale" | "down"
  # Only the gateway block can carry "stale"/"down" (the outer status is
  # "ok"/"degraded"), so a substring match is unambiguous.
  case "$BODY" in
    *'"status":"stale"'* | *'"status":"down"'*) exit 1 ;;
  esac
fi

exit 0
