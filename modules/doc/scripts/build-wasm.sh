#!/usr/bin/env bash
# Build the paged.doc engine wasm (docx-js) and land the wasm-bindgen
# `--target web` output in packages/doc-bundle/bin/ — the path the manifest
# declares under capabilities.wasm[] (governance + the 100 MB plugin-cli size
# gate). The bundle loads it via the wasm-bindgen glue (the core/canvas-wasm
# pattern), NOT via loadBundleWasm.
#
# The steps, the pin check, wasm-opt and the size gates are the shared
# tooling/rust/build-wasm.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

# Budget guard: the save-back patcher (docx-export) MUST stay a byte-level splice
# and never call the ooxmlsdk serializer — the first `write_to`/`to_xml`/
# `serialize_root` monomorphization links the whole WML write codegen and blows
# the app wasm budget. Fail fast on an actual call (comments/descriptions excluded).
if grep -rnE 'serialize_root\(|\.write_to\(|\.to_xml\(' docx-export/src/ >/dev/null; then
  echo "error: docx-export calls the ooxmlsdk serializer — save-back must byte-splice" >&2
  grep -rnE 'serialize_root\(|\.write_to\(|\.to_xml\(' docx-export/src/ >&2
  exit 1
fi

# The `wasm-release` profile (Cargo.toml) keeps the artifact under the
# manifest's `maxBytes`, which the build is also held to (a host that honours
# it refuses a larger file).
exec bash ../../tooling/rust/build-wasm.sh \
  --package docx-js --artifact docx_js --profile wasm-release \
  --out packages/doc-bundle/bin \
  --manifest packages/doc-bundle/manifest.json
