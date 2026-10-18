#!/bin/sh
# Installs the build tools that rust-toolchain.toml and .prototools don't:
# the wasm-bindgen CLI (it must match the wasm-bindgen crate version in the
# Cargo.lock files exactly) and binaryen's wasm-opt. Prints what it would do
# and asks first; `--yes` skips the question (CI).
#
#   tooling/bootstrap.sh          # check, then offer to install what's missing
#   tooling/bootstrap.sh --check  # check only; exits 1 when something is missing
set -eu
WASM_BINDGEN=0.2.129
BINARYEN=126

mode=${1:-ask}
missing=""

have_bindgen=$(wasm-bindgen --version 2>/dev/null | awk '{print $2}' || true)
if [ "$have_bindgen" = "$WASM_BINDGEN" ]; then
  echo "ok       wasm-bindgen $WASM_BINDGEN"
else
  echo "missing  wasm-bindgen $WASM_BINDGEN (found: ${have_bindgen:-none})"
  missing="$missing bindgen"
fi

have_opt=$(wasm-opt --version 2>/dev/null | awk '{print $3}' || true)
if [ "$have_opt" = "$BINARYEN" ]; then
  echo "ok       wasm-opt $BINARYEN"
else
  echo "missing  wasm-opt (binaryen) $BINARYEN (found: ${have_opt:-none})"
  missing="$missing binaryen"
fi

[ -z "$missing" ] && exit 0
[ "$mode" = --check ] && exit 1

echo
for m in $missing; do
  case $m in
    bindgen) echo "would run: cargo install --locked wasm-bindgen-cli --version $WASM_BINDGEN" ;;
    binaryen)
      case "$(uname -s)" in
        Darwin) echo "would run: brew install binaryen   (check that it is version $BINARYEN)" ;;
        *) echo "would run: download binaryen version_$BINARYEN into ~/.local/binaryen and add its bin/ to PATH" ;;
      esac ;;
  esac
done
if [ "$mode" != --yes ]; then
  printf 'Install these now? [y/N] '
  read -r answer
  [ "$answer" = y ] || [ "$answer" = Y ] || exit 1
fi

for m in $missing; do
  case $m in
    bindgen) cargo install --locked wasm-bindgen-cli --version "$WASM_BINDGEN" ;;
    binaryen)
      case "$(uname -s)" in
        Darwin) brew install binaryen ;;
        *)
          arch=$(uname -m)
          dest="$HOME/.local/binaryen"
          mkdir -p "$dest"
          curl -fsSL "https://github.com/WebAssembly/binaryen/releases/download/version_$BINARYEN/binaryen-version_$BINARYEN-$arch-linux.tar.gz" |
            tar -xz -C "$dest" --strip-components=1
          echo "add to PATH: $dest/bin" ;;
      esac ;;
  esac
done
