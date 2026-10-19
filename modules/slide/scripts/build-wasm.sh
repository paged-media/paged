#!/usr/bin/env bash
# Build the paged.slide engine wasm (slide-js) and land the wasm-bindgen
# `--target web` output in packages/slide-bundle/bin/, the path the manifest
# declares under capabilities.wasm[]. The bundle loads it through the
# wasm-bindgen glue (the canvas-wasm pattern), not loadBundleWasm.
#
# The steps, the pin check (WASM_BINDGEN names a specific binary when the one
# on PATH is another version), wasm-opt and the size gate are the shared
# tooling/rust/build-wasm.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

exec bash ../../tooling/rust/build-wasm.sh \
  --package slide-js --artifact slide_js \
  --out packages/slide-bundle/bin
