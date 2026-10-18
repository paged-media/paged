#!/usr/bin/env bash
# Runs a Bun subcommand that only canary builds have yet (`bun lint`, and
# `bun fmt` next) with ONE exact, immutable canary build: the npm package
# `bun@<version>`, version read from bun-canary.version beside this script.
#
#   tooling/js/bun-canary.sh lint --no-script [args...]
#
# The runtime and package manager stay on the Bun in /.prototools; only these
# commands use the canary. `bunx` fetches it once into Bun's cache. When a
# stable Bun ships the command, pin that release in /.prototools, call `bun`
# directly and delete this script (docs/migration/bun-lint.md).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
version="$(tr -d '[:space:]' < "$here/bun-canary.version")"
exec bunx "bun@${version}" "$@"
