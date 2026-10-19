#!/usr/bin/env bash
# build-wasm.sh — build the web-render crate to the bundle's wasm artifact
# (ADR-011 Option B: "HTML/CSS in, scene layer out").
#
# Two modes:
#
#   --engine  the ENGINE artifact the bundle ships and every test lane uses:
#     web-render with the `blitz` feature (the full Stylo/Taffy/Parley stack,
#     the capture sink and the vendored font), exposing
#     render_web_frame / render_web_flow / engine_source_hash.
#
#   (default) the LOWERING artifact: default features only (the pure
#     lowering + wire types, no Blitz). A light check that the lowering
#     compiles and binds on wasm32; it renders nothing.
#
# Both stamp the source hash (tooling/js/source-hash.mjs) into the wasm and into
# bin/SOURCE_HASH, so packages/web-bundle/test/wasm-fresh.spec.ts can tell a
# wasm built from these sources from one built from older ones.
#
# The steps, the pin check against packages/web-render/Cargo.lock, wasm-opt
# and the size gates are the shared tooling/rust/build-wasm.sh. The crate's
# `wasm-release` profile (Cargo.toml: release + fat LTO in one codegen unit)
# is what the shipped size depends on. The ceiling is the manifest's
# `capabilities.wasm[blitz].maxBytes` (read by the build, so the two cannot
# drift): the shipped size plus a small margin, so growth fails the build and
# a raise is a reviewed change. The app-wide sum is the editor's concern (its
# scripts/wasm-budget.mjs).
#
# Output: packages/web-bundle/bin/blitz_web*.{wasm,js} (gitignored).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

FEATURES=()
MODE="lowering"
if [[ "${1:-}" == "--engine" ]]; then
  FEATURES=(--features blitz)
  MODE="engine"
fi
echo "build-wasm: web, mode=$MODE"

exec bash ../../tooling/rust/build-wasm.sh \
  --crate-dir packages/web-render --artifact web_render --out-name blitz_web \
  --profile wasm-release ${FEATURES[@]+"${FEATURES[@]}"} \
  --out packages/web-bundle/bin \
  --source-hash web --hash-env WEB_RENDER_SOURCE_HASH \
  --manifest packages/web-bundle/manifest.json \
  --ensure-target --brotli
