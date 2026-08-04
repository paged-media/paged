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
# The artifact is COMMITTED (paged.image's convention for the copy the
# bundle imports): `pnpm test` and `pnpm -r typecheck` must pass on a
# fresh checkout without a Rust toolchain, and the plugin-cli size gate
# only measures a file that exists.
#
# wasm-opt: CI pins binaryen (an old apt binaryen breaks wasm-bindgen
# externref table grow — the "Table.grow failed" gotcha); locally it is
# applied when present and skipped with a warning when absent.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=packages/draw-bundle/wasm
# Declared in manifest.json under capabilities.wasm[].maxBytes. Keep the
# two in step — the check below is against THIS value and the manifest is
# what the host enforces.
BUDGET=$((2 * 1024 * 1024))

cargo build --release --target wasm32-unknown-unknown -p trace-js

# Pin check: wasm-bindgen-cli must match the Cargo.lock wasm-bindgen, or
# the generated glue does not match the module.
LOCKED=$(grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | grep version | head -1 | cut -d'"' -f2)
CLI=$(wasm-bindgen --version | awk '{print $2}')
if [ "$LOCKED" != "$CLI" ]; then
  echo "error: wasm-bindgen-cli $CLI != Cargo.lock wasm-bindgen $LOCKED" >&2
  echo "       cargo install wasm-bindgen-cli --version $LOCKED" >&2
  exit 1
fi

mkdir -p "$OUT"
wasm-bindgen target/wasm32-unknown-unknown/release/trace_js.wasm \
  --target web --out-dir "$OUT"

# The feature flags are NOT optional: rustc emits bulk-memory + sign-ext
# ops by default, and wasm-opt validates them off unless told otherwise
# (it fails with "memory.copy operations require bulk memory operations").
# A wasm-opt failure is a WARNING, not a build stop — the unoptimized
# artifact is correct, only larger, and the size gate below is the real
# check either way.
if command -v wasm-opt >/dev/null 2>&1; then
  if ! wasm-opt -Oz \
      --enable-bulk-memory --enable-bulk-memory-opt \
      --enable-sign-ext --enable-mutable-globals \
      --enable-nontrapping-float-to-int --enable-reference-types \
      "$OUT/trace_js_bg.wasm" -o "$OUT/trace_js_bg.wasm.opt"; then
    echo "warning: wasm-opt failed — shipping the unoptimized artifact" >&2
    rm -f "$OUT/trace_js_bg.wasm.opt"
  else
    mv "$OUT/trace_js_bg.wasm.opt" "$OUT/trace_js_bg.wasm"
  fi
else
  echo "warning: wasm-opt not found — shipping unoptimized wasm (CI optimizes)" >&2
fi

SIZE=$(wc -c < "$OUT/trace_js_bg.wasm" | tr -d ' ')
echo "trace_js_bg.wasm: $SIZE bytes (budget $BUDGET)"
if [ "$SIZE" -gt "$BUDGET" ]; then
  echo "error: wasm artifact exceeds the declared ${BUDGET}-byte plugin budget" >&2
  echo "       raise capabilities.wasm[].maxBytes in packages/draw-bundle/manifest.json" >&2
  echo "       AND this script together, or shrink the artifact" >&2
  exit 1
fi
