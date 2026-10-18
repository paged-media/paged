#!/usr/bin/env bash
# Build the engine's wasm-bindgen packages into dist/<package>/, the way
# core-publish-wasm.yml builds them for npm: the `wasm-release` profile,
# `wasm-bindgen --target web`, `wasm-opt -Oz` (when binaryen is on PATH) and
# a package.json.
#
#   bash scripts/build-wasm-packages.sh                  # all four
#   bash scripts/build-wasm-packages.sh canvas-wasm sdk  # a subset
#
# Packages: canvas-wasm, introspect-wasm, repo-wasm, sdk.
#
# The version defaults to 0.<PROTOCOL_VERSION>.0-local: the editor reads the
# protocol from the package version's minor, so a local build must carry the
# engine's real protocol. Set PAGED_WASM_VERSION to override it.
#
# wasm-bindgen-cli must match the wasm-bindgen version in Cargo.lock (checked
# below; a mismatched CLI writes glue that does not fit the module).
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET=wasm32-unknown-unknown
TARGET_DIR="${CARGO_TARGET_DIR:-target}"
OUT_ROOT=dist

PROTOCOL="$(grep -oE 'PROTOCOL_VERSION: ProtocolVersion = ProtocolVersion\(([0-9]+)\)' \
  crates/paged-canvas/src/channel.rs | grep -oE '[0-9]+' | head -1)"
[ -n "$PROTOCOL" ] || { echo "build-wasm-packages: cannot read PROTOCOL_VERSION" >&2; exit 1; }
VERSION="${PAGED_WASM_VERSION:-0.$PROTOCOL.0-local}"

LOCKED=$(awk '/^name = "wasm-bindgen"$/{getline; gsub(/version = "|"/,""); print; exit}' Cargo.lock)
command -v wasm-bindgen >/dev/null 2>&1 || {
  echo "build-wasm-packages: wasm-bindgen not found; cargo install wasm-bindgen-cli --version $LOCKED --locked" >&2
  exit 1
}
CLI=$(wasm-bindgen --version | awk '{print $2}')
if [ "$CLI" != "$LOCKED" ]; then
  echo "build-wasm-packages: wasm-bindgen-cli $CLI != Cargo.lock wasm-bindgen $LOCKED" >&2
  exit 1
fi

# <package> -> "<crate> <artifact stem> <cargo features>"
spec() {
  case "$1" in
    canvas-wasm)     echo "paged-canvas-wasm paged_canvas_wasm gpu" ;;
    introspect-wasm) echo "paged-introspect-wasm paged_introspect_wasm -" ;;
    repo-wasm)       echo "paged-repo-wasm paged_repo_wasm -" ;;
    sdk)             echo "paged-sdk paged_sdk gpu" ;;
    *) echo "build-wasm-packages: unknown package '$1'" >&2; return 1 ;;
  esac
}

build() {
  local pkg="$1" crate stem features out files
  read -r crate stem features <<<"$(spec "$pkg")"
  out="$OUT_ROOT/$pkg"
  echo "==> @paged-media/$pkg ($crate) -> $out"
  if [ "$features" = "-" ]; then
    cargo build --profile wasm-release --target "$TARGET" -p "$crate"
  else
    cargo build --profile wasm-release --target "$TARGET" -p "$crate" --features "$features"
  fi
  rm -rf "$out"
  mkdir -p "$out"
  wasm-bindgen "$TARGET_DIR/$TARGET/wasm-release/$stem.wasm" --target web --out-dir "$out"
  if command -v wasm-opt >/dev/null 2>&1; then
    wasm-opt -Oz "$out/${stem}_bg.wasm" -o "$out/${stem}_bg.wasm.opt" \
      && mv "$out/${stem}_bg.wasm.opt" "$out/${stem}_bg.wasm"
  else
    echo "build-wasm-packages: wasm-opt not found; $pkg is not size-optimised" >&2
  fi
  files="'$stem.js','${stem}_bg.wasm','$stem.d.ts'"
  if [ "$pkg" = "introspect-wasm" ]; then
    # The static capability catalog ships beside the wasm (as published).
    cp crates/paged-introspect/catalog.json "$out/catalog.json"
    files="$files,'catalog.json'"
  fi
  node -e "require('fs').writeFileSync('$out/package.json', JSON.stringify({
    name: '@paged-media/$pkg',
    version: '$VERSION',
    type: 'module',
    main: '$stem.js',
    types: '$stem.d.ts',
    files: [$files],
    license: 'MPL-2.0 OR LicenseRef-PMEL'
  }, null, 2) + '\n')"
}

if [ "$#" -eq 0 ]; then
  set -- canvas-wasm introspect-wasm repo-wasm sdk
fi
for pkg in "$@"; do
  spec "$pkg" >/dev/null
done
for pkg in "$@"; do
  build "$pkg"
done
echo "build-wasm-packages: $* at $VERSION in $OUT_ROOT/"
