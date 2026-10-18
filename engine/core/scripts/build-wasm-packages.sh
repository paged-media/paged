#!/usr/bin/env bash
# Build the engine's wasm-bindgen surfaces into the two npm packages that ship
# them (PM-0008), as release.yml builds them for npm: the `wasm-release`
# profile, `wasm-bindgen --target web` and `wasm-opt -Oz`.
#
#   bash scripts/build-wasm-packages.sh --workspace             # all four parts, into the workspace packages
#   bash scripts/build-wasm-packages.sh --workspace session     # a subset
#   bash scripts/build-wasm-packages.sh                         # all four, into dist/
#   bash scripts/build-wasm-packages.sh canvas repo             # a subset, into dist/
#
# Parts, and where --workspace writes them:
#
#   canvas      paged-canvas-wasm     packages/canvas-wasm/              @paged-media/canvas-wasm
#   introspect  paged-introspect-wasm packages/canvas-wasm/introspect/   @paged-media/canvas-wasm/introspect
#                                     (+ catalog.json)
#   repo        paged-repo-wasm       packages/canvas-wasm/repo/         @paged-media/canvas-wasm/repo
#   session     paged-sdk             web/idml-viewer/wasm/              @paged-media/idml-viewer/session
#
# The names the parts had as packages of their own (canvas-wasm,
# introspect-wasm, repo-wasm, sdk) are accepted too.
#
# --workspace fills the packages of the root Bun workspace (ADR 185): their
# committed package.json, README and licence files stay as they are, and the
# generated files are written beside them.
#
# Without it, dist/ gets standalone copies: dist/canvas-wasm/ is the
# canvas-wasm package (its committed files plus the parts built) at the
# version 0.<PROTOCOL_VERSION>.0-local (PAGED_WASM_VERSION overrides it), and
# dist/session/ holds the session's generated files, which ship inside
# @paged-media/idml-viewer. The editor reads the protocol from the package
# version's minor, so a local build carries the engine's real protocol.
#
# wasm-bindgen-cli must match the wasm-bindgen version in Cargo.lock (checked
# below; a mismatched CLI writes glue that does not fit the module). wasm-opt
# (binaryen) is optional locally and required under CI.
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET=wasm32-unknown-unknown
TARGET_DIR="${CARGO_TARGET_DIR:-target}"
CANVAS_PKG=packages/canvas-wasm

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

# A part's name, from its own or its former package name.
part_of() {
  case "$1" in
    canvas | canvas-wasm) echo canvas ;;
    introspect | introspect-wasm) echo introspect ;;
    repo | repo-wasm) echo repo ;;
    session | sdk) echo session ;;
    *) echo "build-wasm-packages: unknown part '$1' (canvas, introspect, repo, session)" >&2; return 1 ;;
  esac
}

# <part> -> "<crate> <artifact stem> <cargo features> <workspace dir> <dist dir>"
spec() {
  case "$1" in
    canvas)     echo "paged-canvas-wasm paged_canvas_wasm gpu $CANVAS_PKG dist/canvas-wasm" ;;
    introspect) echo "paged-introspect-wasm paged_introspect_wasm - $CANVAS_PKG/introspect dist/canvas-wasm/introspect" ;;
    repo)       echo "paged-repo-wasm paged_repo_wasm - $CANVAS_PKG/repo dist/canvas-wasm/repo" ;;
    session)    echo "paged-sdk paged_sdk gpu web/idml-viewer/wasm dist/session" ;;
  esac
}

# dist/canvas-wasm/ starts from the committed package files, once per run.
DIST_CANVAS_READY=
dist_canvas_shell() {
  [ -n "$DIST_CANVAS_READY" ] && return 0
  rm -rf dist/canvas-wasm
  mkdir -p dist/canvas-wasm
  cp "$CANVAS_PKG/package.json" "$CANVAS_PKG/README.md" "$CANVAS_PKG/LICENSE" "$CANVAS_PKG/LICENSE.md" dist/canvas-wasm/
  bun -e '
    const fs = require("fs");
    const file = process.argv[1];
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    pkg.version = process.argv[2];
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  ' dist/canvas-wasm/package.json "$VERSION"
  DIST_CANVAS_READY=1
}

build() {
  local part="$1" crate stem features wsdir distdir gen out
  read -r crate stem features wsdir distdir <<<"$(spec "$part")"
  [ -f "$CANVAS_PKG/package.json" ] || { echo "build-wasm-packages: $CANVAS_PKG/package.json missing" >&2; return 1; }
  if [ "$MODE" = workspace ]; then
    out="$wsdir"
  else
    out="$distdir"
    case "$part" in canvas | introspect | repo) dist_canvas_shell ;; esac
  fi
  echo "==> $part ($crate) -> $out"
  if [ "$features" = "-" ]; then
    cargo build --profile wasm-release --target "$TARGET" -p "$crate"
  else
    cargo build --profile wasm-release --target "$TARGET" -p "$crate" --features "$features"
  fi

  # Generate into a scratch directory, then move the result into place, so a
  # failed step leaves the previous build (and the committed files) as they were.
  gen="$(mktemp -d)"
  wasm-bindgen "$TARGET_DIR/$TARGET/wasm-release/$stem.wasm" --target web --out-dir "$gen"
  if command -v wasm-opt >/dev/null 2>&1; then
    wasm-opt -Oz "$gen/${stem}_bg.wasm" -o "$gen/${stem}_bg.wasm.opt"
    mv "$gen/${stem}_bg.wasm.opt" "$gen/${stem}_bg.wasm"
  else
    echo "build-wasm-packages: wasm-opt not found; $part is not size-optimised" >&2
  fi
  if [ "$part" = introspect ]; then
    # The static capability catalog ships beside the introspection wasm.
    cp crates/paged-introspect/catalog.json "$gen/catalog.json"
  fi

  # Only what an earlier build of this part generated goes; the committed
  # files, and the other parts' subdirectories, stay.
  mkdir -p "$out"
  rm -rf "$out/$stem".* "$out/${stem}_bg".* "$out/snippets"
  if [ "$part" = introspect ]; then rm -f "$out/catalog.json"; fi
  cp -R "$gen"/. "$out"/
  rm -rf "$gen"

  # Every file of the part exists.
  for f in "$stem.js" "$stem.d.ts" "${stem}_bg.wasm"; do
    [ -f "$out/$f" ] || { echo "build-wasm-packages: $out lacks $f" >&2; return 1; }
  done
}

if [ "$#" -eq 0 ]; then
  set -- canvas introspect repo session
fi
PARTS=()
for arg in "$@"; do
  PARTS+=("$(part_of "$arg")")
done
for part in "${PARTS[@]}"; do
  build "$part"
done
if [ "$MODE" = workspace ]; then
  echo "build-wasm-packages: ${PARTS[*]} in the workspace packages (versions as committed)"
else
  echo "build-wasm-packages: ${PARTS[*]} in dist/ (canvas-wasm at $VERSION)"
fi
