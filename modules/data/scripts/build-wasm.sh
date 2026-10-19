#!/usr/bin/env bash
# Build the paged.data engine wasm (data-js) and land the wasm-bindgen
# `--target web` output in packages/data-bundle/bin/ — the path the manifest
# declares under capabilities.wasm[] (governance + the 100 MB plugin-cli size
# gate). The bundle loads it via the wbindgen glue (the core/canvas-wasm
# pattern), NOT via loadBundleWasm — BREAKAGE D-07. NOTE: the multi-MB
# DuckDB-WASM artifact is SEPARATE (vendor/duckdb-wasm/, scripts/vendor-duckdb.sh)
# and is NOT subject to this 100 MB app-wide budget (D-07b).
#
# The steps, the pin check, wasm-opt and the size gate are the shared
# tooling/rust/build-wasm.sh. The source hash is stamped into the wasm and
# beside it, so packages/data-bundle/test/wasm-fresh.spec.ts can tell a wasm
# built from these sources from one built from older ones.
set -euo pipefail
cd "$(dirname "$0")/.."

exec bash ../../tooling/rust/build-wasm.sh \
  --package data-js --artifact data_js \
  --out packages/data-bundle/bin \
  --source-hash data --hash-env DATA_JS_SOURCE_HASH
