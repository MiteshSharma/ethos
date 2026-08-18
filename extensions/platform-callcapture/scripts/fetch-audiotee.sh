#!/usr/bin/env bash
# Clones and builds the pinned `audiotee` commit (github.com/makeusabrew/audiotee),
# the Phase 3 helper for the OTHER-PARTICIPANTS (system audio / Core Audio
# Process Tap) capture stream. See ../README.md "Phase 3" for the full
# rationale.
#
# audiotee is a Swift Package Manager project, NOT a brew formula — there is
# no `brew install audiotee`. Upstream carries no version tags, so this
# script pins an exact commit rather than a tag.
#
# This is a spike-quality fetch script, not production dependency packaging
# (that's Phase 4/T5 scope) — it re-clones and rebuilds from scratch every
# time rather than caching/diffing, which is fine for an occasional manual
# build step.
#
# Run with: pnpm --filter @ethosagent/platform-callcapture run build:audiotee

set -euo pipefail

AUDIOTEE_REPO="https://github.com/makeusabrew/audiotee.git"
AUDIOTEE_COMMIT="56ac954369a09318e46b88a6eec33c2d2b0d32a3"

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$PKG_DIR/native/vendor/audiotee-src"
OUT_DIR="$PKG_DIR/native/vendor/audiotee"

echo "fetch-audiotee: cloning $AUDIOTEE_REPO @ $AUDIOTEE_COMMIT ..."
rm -rf "$SRC_DIR"
git clone "$AUDIOTEE_REPO" "$SRC_DIR"
git -C "$SRC_DIR" checkout "$AUDIOTEE_COMMIT"

echo "fetch-audiotee: building (swift build -c release) ..."
(cd "$SRC_DIR" && swift build -c release)

mkdir -p "$OUT_DIR"
cp "$SRC_DIR/.build/release/audiotee" "$OUT_DIR/audiotee"
chmod +x "$OUT_DIR/audiotee"

echo "fetch-audiotee: done. Binary at $OUT_DIR/audiotee (pinned commit $AUDIOTEE_COMMIT)"
