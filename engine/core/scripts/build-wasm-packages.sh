#!/usr/bin/env bash
# Build the engine's wasm-bindgen packages, as core-publish-wasm.yml builds
# them for npm: the `wasm-release` profile, `wasm-bindgen --target web` and
# `wasm-opt -Oz`.
#
#   bash scripts/build-wasm-packages.sh --workspace           # all four, into packages/<pkg>/
#   bash scripts/build-wasm-packages.sh --workspace sdk       # a subset
#   bash scripts/build-wasm-packages.sh                       # all four, into dist/<pkg>/
#   bash scripts/build-wasm-packages.sh canvas-wasm sdk       # a subset, into dist/
#
# Packages: canvas-wasm, introspect-wasm, repo-wasm, sdk.
#
# --workspace fills the packages of the root Bun workspace (ADR 185):
# packages/<pkg>/ keeps its committed package.json, README and licence files
# as they are, and the generated files are written beside them.
#
# Without it, dist/<pkg>/ gets a standalone copy: the generated files plus the
# shell's package.json, README and licence files, at the version
# 0.<PROTOCOL_VERSION>.0-local (PAGED_WASM_VERSION overrides it). The editor
# reads the protocol from the package version's minor, so a local build
# carries the engine's real protocol.
#
# wasm-bindgen-cli must match the wasm-bindgen version in Cargo.lock (checked
# below; a mismatched CLI writes glue that does not fit the module). wasm-opt
# (binaryen) is optional locally and required under CI.
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET=wasm32-unknown-unknown
TARGET_DIR="${CARGO_TARGET_DIR:-target}"
SHELLS=packages

MODE=dist
if [ "${1:-}" = "--workspace" ]; then
  MODE=workspace
  shift
fi

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
if ! command -v wasm-opt >/dev/null 2>&1 && [ -n "${CI:-}" ]; then
  echo "build-wasm-packages: wasm-opt not found; CI must not ship unoptimised wasm" >&2
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
  local pkg="$1" crate stem features shell gen out
  read -r crate stem features <<<"$(spec "$pkg")"
  shell="$SHELLS/$pkg"
  [ -f "$shell/package.json" ] || { echo "build-wasm-packages: $shell/package.json missing" >&2; return 1; }
  if [ "$MODE" = workspace ]; then out="$shell"; else out="dist/$pkg"; fi
  echo "==> @paged-media/$pkg ($crate) -> $out"
  if [ "$features" = "-" ]; then
    cargo build --profile wasm-release --target "$TARGET" -p "$crate"
  else
    cargo build --profile wasm-release --target "$TARGET" -p "$crate" --features "$features"
  fi

  # Generate into a scratch directory, then move the result into place, so a
  # failed step leaves the previous build (and the shell) as it was.
  gen="$(mktemp -d)"
  wasm-bindgen "$TARGET_DIR/$TARGET/wasm-release/$stem.wasm" --target web --out-dir "$gen"
  if command -v wasm-opt >/dev/null 2>&1; then
    wasm-opt -Oz "$gen/${stem}_bg.wasm" -o "$gen/${stem}_bg.wasm.opt"
    mv "$gen/${stem}_bg.wasm.opt" "$gen/${stem}_bg.wasm"
  else
    echo "build-wasm-packages: wasm-opt not found; $pkg is not size-optimised" >&2
  fi
  if [ "$pkg" = "introspect-wasm" ]; then
    # The static capability catalog ships beside the wasm (as published).
    cp crates/paged-introspect/catalog.json "$gen/catalog.json"
  fi

  if [ "$MODE" = workspace ]; then
    # Only what an earlier build generated goes; the committed files stay.
    rm -rf "$out/$stem".* "$out/${stem}_bg".* "$out/snippets" "$out/catalog.json"
  else
    rm -rf "$out"
    mkdir -p "$out"
    cp "$shell/package.json" "$shell/README.md" "$shell/LICENSE" "$shell/LICENSE.md" "$out/"
    bun -e '
      const fs = require("fs");
      const file = process.argv[1];
      const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
      pkg.version = process.argv[2];
      fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
    ' "$out/package.json" "$VERSION"
  fi
  cp -R "$gen"/. "$out"/
  rm -rf "$gen"

  # Every file the manifest publishes must now exist.
  bun -e '
    const fs = require("fs");
    const dir = process.argv[1];
    const pkg = JSON.parse(fs.readFileSync(dir + "/package.json", "utf8"));
    const missing = [pkg.main, pkg.types, ...pkg.files].filter((f) => !fs.existsSync(dir + "/" + f));
    if (missing.length) {
      console.error("build-wasm-packages: " + dir + " lacks " + missing.join(", "));
      process.exit(1);
    }
  ' "$out"
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
if [ "$MODE" = workspace ]; then
  echo "build-wasm-packages: $* in $SHELLS/ (versions as committed)"
else
  echo "build-wasm-packages: $* at $VERSION in dist/"
fi
