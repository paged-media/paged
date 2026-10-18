#!/usr/bin/env bash
# Runs a Bun command that the stable Bun in /.prototools does not have yet
# (`bun fmt`, `bun lint`) on the canary build pinned in
# tooling/js/bun-canary-version:
#
#   tooling/js/bun-canary.sh fmt --check .
#   tooling/js/bun-canary.sh lint
#
# That file is the one place the canary version is written. An npm canary
# (`bun@1.4.3-canary.YYYYMMDD.N`) is an exact, immutable build, so every
# machine and CI runs the same formatter and linter. bunx fetches it once
# into Bun's cache. The runtime and package manager stay on the stable Bun.
#
# Do not add `bun` to a package.json instead: node_modules/.bin/bun would
# shadow the runtime for every package script.
#
# Drop this when a stable Bun ships the commands: pin that version in
# /.prototools and call `bun fmt` / `bun lint` directly.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
version=$(tr -d '[:space:]' < "$here/bun-canary-version")
exec bunx "bun@$version" "$@"
