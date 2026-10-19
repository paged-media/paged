#!/usr/bin/env bash
# Build the paged.draw IMAGE TRACE wasm (trace-js) and land the
# wasm-bindgen `--target web` output in packages/draw-bundle/wasm/.
#
# ONE COPY, ON PURPOSE. paged.image ships the artifact twice — once next
# to the bundle source and once next to the manifest — and the two drifted
# (the plugin-cli size gate was measuring a stale file). Here the manifest
# lives AT packages/draw-bundle/manifest.json, so the manifest-relative
# path `wasm/trace_js_bg.wasm` and the bundle's own `../wasm/trace_js.js`
# import resolve to the SAME directory. There is nothing to mirror and
# therefore nothing to drift.
#
# The output is BUILD OUTPUT (gitignored): `moon run draw:wasm` runs this
# script, and CI builds it with .github/actions/module-wasm before the
# specs and the plugin-cli size gate read it. The typecheck does not need
# it. The steps, the pin check and the size gate are the shared
# tooling/rust/build-wasm.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

# The wasm-opt feature flags are NOT optional: rustc emits bulk-memory +
# sign-ext ops by default, and wasm-opt validates them off unless told
# otherwise (it fails with "memory.copy operations require bulk memory
# operations"). A wasm-opt failure is a WARNING, not a build stop — the
# unoptimized artifact is correct, only larger, and the size gate is the
# real check either way.
exec bash ../../tooling/rust/build-wasm.sh \
  --package trace-js --artifact trace_js \
  --out packages/draw-bundle/wasm \
  --wasm-opt-flags "--enable-bulk-memory --enable-bulk-memory-opt --enable-sign-ext --enable-mutable-globals --enable-nontrapping-float-to-int --enable-reference-types" \
  --wasm-opt-optional
