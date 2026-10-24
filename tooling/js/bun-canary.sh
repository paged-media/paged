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
#
# bunx installs the package into one temporary directory per version
# (`$TMPDIR/bunx-<uid>-bun@<version>`) and runs its postinstall, which puts
# the canary's binary in place, on EVERY call. Callers that run it in
# parallel (tooling/js/lint-selftest.mjs runs eight at a time) then race in
# that directory, and a postinstall finds its working directory gone
# ("Unable to determine current working directory"). So the binary bunx
# leaves there is run directly once it answers, and only one caller at a
# time lets bunx install it.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
version=$(tr -d '[:space:]' < "$here/bun-canary-version")
tmp=${TMPDIR:-/tmp}
dir="${tmp%/}/bunx-$(id -u)-bun@$version"
bin="$dir/node_modules/bun/bin/bun.exe"
ready() { [ -x "$bin" ] && "$bin" --revision >/dev/null 2>&1; }
if ! ready; then
  lock="$dir.lock"
  waited=0
  until mkdir "$lock" 2>/dev/null; do
    # A lock older than two minutes is a killed installer's: take it over.
    if [ "$waited" -ge 600 ]; then
      rmdir "$lock" 2>/dev/null || true
      waited=0
      continue
    fi
    sleep 0.2
    waited=$((waited + 1))
  done
  trap 'rmdir "$lock" 2>/dev/null || true' EXIT
  ready || bunx "bun@$version" --revision >/dev/null
  rmdir "$lock" 2>/dev/null || true
  trap - EXIT
fi
# Should bunx ever keep the package elsewhere, run it through bunx as before.
ready || exec bunx "bun@$version" "$@"
exec "$bin" "$@"
