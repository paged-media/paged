#!/usr/bin/env bash
# Build the paged.slide engine wasm (slide-js) and land the wasm-bindgen
# `--target web` output in packages/slide-bundle/bin/, the path the manifest
# declares under capabilities.wasm[]. The bundle loads it through the
# wasm-bindgen glue (the canvas-wasm pattern), not loadBundleWasm.
#
# wasm-opt is applied when present (CI pins binaryen; old apt binaryen breaks
# wasm-bindgen's externref table grow).
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=packages/slide-bundle/bin
# The 100 MB budget is for the whole app including every plugin, enforced as
# a sum by the editor; this per-artifact stop catches a runaway build here.
BUDGET=$((100 * 1000 * 1000))
mkdir -p "$OUT"

cargo build --release --target wasm32-unknown-unknown -p slide-js

# wasm-bindgen-cli must match the locked wasm-bindgen (WASM_BINDGEN names a
# specific binary when the one on PATH is another version).
WB=${WASM_BINDGEN:-wasm-bindgen}
LOCKED=$(grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | grep version | head -1 | cut -d'"' -f2)
CLI=$("$WB" --version | awk '{print $2}')
if [ "$LOCKED" != "$CLI" ]; then
  echo "error: wasm-bindgen-cli $CLI != Cargo.lock wasm-bindgen $LOCKED" >&2
  echo "       cargo install wasm-bindgen-cli --version $LOCKED" >&2
  exit 1
fi

"$WB" target/wasm32-unknown-unknown/release/slide_js.wasm --target web --out-dir "$OUT"

if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz "$OUT/slide_js_bg.wasm" -o "$OUT/slide_js_bg.wasm"
else
  echo "warning: wasm-opt not found, shipping unoptimised wasm (CI optimises)" >&2
fi

SIZE=$(wc -c < "$OUT/slide_js_bg.wasm" | tr -d ' ')
echo "slide_js_bg.wasm: $SIZE bytes (budget $BUDGET)"
if [ "$SIZE" -gt "$BUDGET" ]; then
  echo "error: wasm artifact exceeds the 100 MB app wasm budget" >&2
  exit 1
fi
