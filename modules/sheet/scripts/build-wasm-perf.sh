#!/usr/bin/env bash
# Build the COUNTING engine wasm: sheet-js with the `perf-counters` feature,
# which adds `perfCounters()` / `resetPerfCounters()` (the sheet-calc work
# counters) to the wasm. It lands in packages/sheet-bundle/bin-perf/
# (gitignored), never in bin/: the shipped wasm (scripts/build-wasm.sh)
# carries no counter code.
#
# Used by the TS perf harness (packages/sheet-bundle/test/perf/): with
# PERF_ENGINE=1 and this artifact present, the sessions boot it and
# `PERF_SHOW=1` prints the engine's own counts beside the door counts.
# Trended, not gated — CI does not build it.
#
# A separate --target-dir keeps the feature build from overwriting the
# release artifact build-wasm.sh reads.
set -euo pipefail
cd "$(dirname "$0")/.."

exec bash ../../tooling/rust/build-wasm.sh \
  --package sheet-js --artifact sheet_js --features perf-counters \
  --target-dir "${CARGO_TARGET_DIR:-target}/wasm-perf" \
  --out packages/sheet-bundle/bin-perf \
  --no-wasm-opt --no-budget
