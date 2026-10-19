#!/usr/bin/env bash
# Build the paged.sheet engine wasm (sheet-js) and land the wasm-bindgen
# `--target web` output in packages/sheet-bundle/bin/ — the path the
# manifest declares under capabilities.wasm[] (governance + the 100 MB app-wide
# plugin-cli size gate). The bundle loads it via the wbindgen glue (the
# core/canvas-wasm pattern), NOT via loadBundleWasm — BREAKAGE S-10.
#
# The steps, the pin check, wasm-opt and the size gate are the shared
# tooling/rust/build-wasm.sh. The source hash is stamped into the wasm and
# beside it, so packages/sheet-bundle/test/wasm-fresh.spec.ts can tell a
# wasm built from these sources from one built from older ones.
set -euo pipefail
cd "$(dirname "$0")/.."

exec bash ../../tooling/rust/build-wasm.sh \
  --package sheet-js --artifact sheet_js \
  --out packages/sheet-bundle/bin \
  --source-hash sheet --hash-env SHEET_JS_SOURCE_HASH
