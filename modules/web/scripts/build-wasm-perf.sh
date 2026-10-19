#!/usr/bin/env bash
# build-wasm-perf.sh — build the COUNTING engine wasm for the perf harness.
#
# Same crate and stack as `build-wasm.sh --engine`, plus the `perf-counters`
# feature, which adds the `perf_counters()` / `perf_counters_reset()` exports
# (engine-internal work counts: parses, resolves, paint captures, painted
# commands, run-match comparisons, font-context builds, boundary bytes).
#
# The counting build NEVER goes into the bundle: it is written to
# packages/web-render/target/perf-wasm/ (gitignored, own cargo target dir so
# it does not churn the shipped build), and only the perf spec
# (packages/web-bundle/test/perf/) loads it — to PRINT the engine counts
# beside the host-door counts under PERF_SHOW=1. The gated budgets do not
# need it.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Same profile as the shipped engine (`wasm-release`, Cargo.toml), so the
# wall-clock the perf spec prints is the shipped build's.
CRATE="$PWD/packages/web-render"
exec bash ../../tooling/rust/build-wasm.sh \
  --crate-dir "$CRATE" --artifact web_render --out-name blitz_web \
  --profile wasm-release --features blitz,perf-counters \
  --target-dir "$CRATE/target/perf" \
  --out "$CRATE/target/perf-wasm" \
  --no-wasm-opt --no-budget
