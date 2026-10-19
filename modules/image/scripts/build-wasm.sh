#!/usr/bin/env bash
# Build the paged.image engine wasm (image-js) and land the wasm-bindgen
# `--target web` output in manifest/wasm/ — the path the manifest
# declares under capabilities.wasm[] (governance + the plugin-cli size
# gate; the gate only measures a file that exists, so building HERE
# makes it live). The bundle loads it via the wbindgen glue in the
# BUNDLE REALM (the core/canvas-wasm pattern), NOT via loadBundleWasm —
# the sandbox has no navigator.gpu (BREAKAGE I-07).
#
# The steps, the pin check, wasm-opt and the size gate are the shared
# tooling/rust/build-wasm.sh. The source hash is stamped into the wasm and
# beside it, so glue/test/wasm-fresh.spec.ts can tell a wasm built from these
# sources from one built from older ones. The output is BUILD OUTPUT
# (gitignored): `moon run image:wasm` runs this script, and CI builds it with
# .github/actions/module-wasm.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=glue/wasm
bash ../../tooling/rust/build-wasm.sh \
  --package image-js --artifact image_js \
  --out "$OUT" \
  --source-hash image --hash-env IMAGE_JS_SOURCE_HASH

# The BUNDLE loads the glue from glue/wasm (its `../wasm/…` relative
# import); the MANIFEST declares `wasm/image_js_bg.wasm` relative to
# manifest/, which is what the plugin-cli size gate measures. Both must
# be the same artifact — mirror it so the two never drift (they did:
# the gate was measuring a stale copy).
mkdir -p manifest/wasm
cp "$OUT"/image_js.js "$OUT"/image_js.d.ts \
   "$OUT"/image_js_bg.wasm "$OUT"/image_js_bg.wasm.d.ts manifest/wasm/
