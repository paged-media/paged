#!/usr/bin/env bash
# build-wasm.sh — build the pdf-import mapper crate to the pdf bundle's wasm
# artifact.
#
# pdf-import is the PDF-BLIND Rust mapper: a reading-ordered Document IR (JSON,
# emitted by the pdf-bundle's pdf.js reconstruction) → paged_scene::Document →
# native `.paged` OCF bytes. This script compiles it to wasm32 and runs
# wasm-bindgen `--target web`, producing the glue + module the bundle's
# `engine-loader.ts` imports. The mapper is tiny (serde + zip + the paged
# model, no PDF stack); the size it prints flags an accidental heavy dep.
#
# Built from the workspace root so the shared git-dep lock is reused; -p
# selects just the mapper (idml-import/-export are not needed for the bundle).
# The steps, the pin check, wasm-opt and the size gate are the shared
# tooling/rust/build-wasm.sh.
#
# Output: packages/pdf-bundle/bin/pdf_import.js + pdf_import_bg.wasm
# (manifest `capabilities.wasm`; gitignored build output, built by
# `moon run publish:wasm` and in CI by .github/actions/module-wasm).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

exec bash ../../tooling/rust/build-wasm.sh \
  --package pdf-import --artifact pdf_import \
  --out packages/pdf-bundle/bin \
  --ensure-target
