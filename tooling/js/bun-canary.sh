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
# machine and CI runs the same formatter and linter. The runtime and package
# manager stay on the stable Bun.
#
# The canary is installed ONCE per version into a cache directory and its
# binary is then run directly. It used to be run through `bunx bun@…`, whose
# first install runs the `bun` package's postinstall in a shared temporary
# directory: several runs starting at once (the lint self-test spawns them in
# parallel; so do parallel sessions on one machine) raced in that directory
# and left a package without its binary ("postinstall script from bun exited
# with 1", `uv_cwd ENOENT`). Now one installer at a time holds a lock, and it
# installs the platform package (`@oven/bun-<os>-<arch>`), which carries the
# binary itself, so no install script runs at all.
#
#   PAGED_BUN_CANARY_HOME   where the versions are kept
#                           (default: $XDG_CACHE_HOME or ~/.cache, /paged/bun-canary)
#
# Do not add `bun` to a package.json instead: node_modules/.bin/bun would
# shadow the runtime for every package script.
#
# Drop this when a stable Bun ships the commands: pin that version in
# /.prototools and call `bun fmt` / `bun lint` directly.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
version=$(tr -d '[:space:]' < "$here/bun-canary-version")

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in
  arm64 | aarch64) arch=aarch64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) arch=$(uname -m) ;;
esac
pkg="@oven/bun-$os-$arch"

home="${PAGED_BUN_CANARY_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/paged/bun-canary}"
dir="$home/$version-$os-$arch"
bin="$dir/node_modules/$pkg/bin/bun"

if [ ! -x "$bin" ]; then
  mkdir -p "$home"
  lock="$dir.lock"
  # mkdir is atomic: the first run installs, the others wait for it (a lock
  # older than ten minutes is a crashed installer's and is taken over).
  waited=0
  locked=0
  while true; do
    if mkdir "$lock" 2>/dev/null; then
      locked=1
      break
    fi
    if [ -x "$bin" ]; then break; fi
    if [ "$waited" -ge 1200 ]; then
      rmdir "$lock" 2>/dev/null || true
      waited=0
      continue
    fi
    sleep 0.5
    waited=$((waited + 1))
  done
  if [ ! -x "$bin" ]; then
    trap 'rmdir "$lock" 2>/dev/null || true' EXIT
    stage="$dir.stage.$$"
    mkdir -p "$stage"
    printf '{ "name": "paged-bun-canary", "private": true }\n' > "$stage/package.json"
    (cd "$stage" && bun add --exact --silent "$pkg@$version" >&2)
    if [ ! -x "$stage/node_modules/$pkg/bin/bun" ]; then
      echo "bun-canary: $pkg@$version installed without its binary ($stage)" >&2
      exit 1
    fi
    # Publish the finished install in one rename (a half-written directory is
    # never visible under its real name).
    if [ -e "$dir" ]; then mv "$dir" "$dir.old.$$"; fi
    mv "$stage" "$dir"
    rmdir "$lock" 2>/dev/null || true
    trap - EXIT
  elif [ "$locked" = 1 ]; then
    rmdir "$lock" 2>/dev/null || true
  fi
fi

exec "$bin" "$@"
