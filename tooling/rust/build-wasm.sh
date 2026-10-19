#!/usr/bin/env bash
# The one wasm build of the built-in modules: cargo for wasm32, wasm-bindgen
# `--target web`, wasm-opt, the source-hash stamp and the size gates. Each
# module's scripts/build-wasm.sh calls it with that module's crate, output
# directory and gates, and keeps only what is its own (doc's serializer
# guard, image's manifest copy, web's two modes).
#
#   tooling/rust/build-wasm.sh --package <cargo -p> --artifact <stem> --out <dir> [options]
#
# Run from the module's directory; relative paths are relative to it.
#
#   --package NAME        the crate to build (cargo -p); omit it to build the
#                         crate in --crate-dir
#   --artifact STEM       the cdylib's file stem (target/…/<STEM>.wasm)
#   --out DIR             where the glue and the wasm land
#   --out-name NAME       wasm-bindgen --out-name (default: STEM)
#   --crate-dir DIR       where cargo runs and Cargo.lock is read (default .)
#   --profile NAME        cargo profile (default release)
#   --features LIST       cargo --features
#   --target-dir DIR      cargo --target-dir (default: CARGO_TARGET_DIR, else
#                         target/; a relative one is relative to --crate-dir)
#   --source-hash MODULE  stamp tooling/js/source-hash.mjs MODULE into the wasm
#   --hash-env VAR        … through this env var (the crate's option_env!) and
#                         beside it, as <out>/SOURCE_HASH
#   --wasm-opt-flags STR  flags after wasm-opt -Oz (feature enables)
#   --wasm-opt-optional   a wasm-opt failure warns and keeps the unoptimised wasm
#   --no-wasm-opt         skip wasm-opt (the perf builds)
#   --manifest FILE       also hold the wasm to the maxBytes FILE declares for it
#                         (the capabilities.wasm[] entry whose path names it)
#   --no-budget           no size gate (the perf builds)
#   --ensure-target       rustup target add wasm32-unknown-unknown when missing
#   --brotli              also print the brotli transfer size
#
# Environment: WASM_BINDGEN names the wasm-bindgen binary (default: the one on
# PATH). It must equal the wasm-bindgen version in Cargo.lock, or the glue
# does not match the module; the check runs before the build.
#
# wasm-opt: CI pins binaryen (an old apt binaryen breaks wasm-bindgen's
# externref table grow, the "Table.grow failed" gotcha); locally it is applied
# when present and skipped with a warning when absent.
#
# The size gate: 100 MB is the budget for the WHOLE APP, every plugin
# included (2026-08-19), enforced as a sum by the editor's
# scripts/wasm-budget.mjs. This per-artifact stop keeps a runaway build from
# sailing through unnoticed; the number that governs is the app total.
# Mirrors plugin-sdk WASM_BUDGETS: change them together.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="wasm32-unknown-unknown"
BUDGET=$((100 * 1000 * 1000))

PACKAGE="" ARTIFACT="" OUT="" OUT_NAME="" CRATE_DIR="." PROFILE="release"
FEATURES="" TARGET_DIR="" HASH_MODULE="" HASH_ENV="" OPT_FLAGS=""
OPT=1 OPT_OPTIONAL=0 MANIFEST="" GATE=1 ENSURE_TARGET=0 BROTLI=0

die() {
  echo "build-wasm: error: $*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --package) PACKAGE=$2; shift 2 ;;
    --artifact) ARTIFACT=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --out-name) OUT_NAME=$2; shift 2 ;;
    --crate-dir) CRATE_DIR=$2; shift 2 ;;
    --profile) PROFILE=$2; shift 2 ;;
    --features) FEATURES=$2; shift 2 ;;
    --target-dir) TARGET_DIR=$2; shift 2 ;;
    --source-hash) HASH_MODULE=$2; shift 2 ;;
    --hash-env) HASH_ENV=$2; shift 2 ;;
    --wasm-opt-flags) OPT_FLAGS=$2; shift 2 ;;
    --wasm-opt-optional) OPT_OPTIONAL=1; shift ;;
    --no-wasm-opt) OPT=0; shift ;;
    --manifest) MANIFEST=$2; shift 2 ;;
    --no-budget) GATE=0; shift ;;
    --ensure-target) ENSURE_TARGET=1; shift ;;
    --brotli) BROTLI=1; shift ;;
    *) die "unknown option $1" ;;
  esac
done
[ -n "$ARTIFACT" ] || die "--artifact is required"
[ -n "$OUT" ] || die "--out is required"
if [ -n "$HASH_MODULE" ] && [ -z "$HASH_ENV" ]; then
  die "--source-hash needs --hash-env"
fi
OUT_NAME=${OUT_NAME:-$ARTIFACT}
CRATE_DIR=$(cd "$CRATE_DIR" && pwd)

if [ "$ENSURE_TARGET" = 1 ] && ! rustup target list --installed 2>/dev/null | grep -q "$TARGET"; then
  echo "build-wasm: installing the $TARGET target" >&2
  rustup target add "$TARGET"
fi

# The pin check, before the (long) build.
WB=${WASM_BINDGEN:-wasm-bindgen}
LOCKED=$(grep -A1 '^name = "wasm-bindgen"$' "$CRATE_DIR/Cargo.lock" | grep version | head -1 | cut -d'"' -f2)
command -v "$WB" >/dev/null 2>&1 \
  || die "wasm-bindgen not found; cargo install wasm-bindgen-cli --version $LOCKED"
CLI=$("$WB" --version | awk '{print $2}')
if [ "$LOCKED" != "$CLI" ]; then
  echo "build-wasm: error: wasm-bindgen-cli $CLI != Cargo.lock wasm-bindgen $LOCKED" >&2
  echo "            cargo install wasm-bindgen-cli --version $LOCKED" >&2
  exit 1
fi

# The source hash goes into the wasm through an option_env! variable (which
# cargo tracks) and beside it, so the module's test/wasm-fresh.spec.ts can
# tell a wasm built from these sources from one built from older ones.
SOURCE_HASH=""
if [ -n "$HASH_MODULE" ]; then
  SOURCE_HASH=$(bun "$REPO/tooling/js/source-hash.mjs" "$HASH_MODULE")
fi

# Cargo names a crate outside the module's own workspace (platform/shared/*,
# a path dependency) by its absolute path, so its panic locations would carry
# the build machine's directory into the wasm, and the artifact's size would
# depend on where the checkout is. Name those sources relative to the
# repository, as cargo names the workspace's own crates.
export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }--remap-path-prefix=$REPO/platform/shared/=platform/shared/"

CARGO_ARGS=(build --profile "$PROFILE" --target "$TARGET")
[ -n "$PACKAGE" ] && CARGO_ARGS+=(-p "$PACKAGE")
[ -n "$FEATURES" ] && CARGO_ARGS+=(--features "$FEATURES")
[ -n "$TARGET_DIR" ] && CARGO_ARGS+=(--target-dir "$TARGET_DIR")
(
  cd "$CRATE_DIR"
  if [ -n "$HASH_ENV" ]; then export "$HASH_ENV=$SOURCE_HASH"; fi
  cargo "${CARGO_ARGS[@]}"
)

# Where cargo wrote it: --target-dir, else CARGO_TARGET_DIR, else target/,
# a relative one under the directory cargo ran in. The release and dev
# profiles keep their historical directory names.
DIR=${TARGET_DIR:-${CARGO_TARGET_DIR:-target}}
[[ "$DIR" = /* ]] || DIR="$CRATE_DIR/$DIR"
case "$PROFILE" in
  dev) PROFILE_DIR=debug ;;
  *) PROFILE_DIR=$PROFILE ;;
esac
WASM_IN="$DIR/$TARGET/$PROFILE_DIR/$ARTIFACT.wasm"
[ -f "$WASM_IN" ] || die "expected $WASM_IN; the build produced no cdylib"

mkdir -p "$OUT"
"$WB" "$WASM_IN" --target web --out-dir "$OUT" --out-name "$OUT_NAME"
BG="$OUT/${OUT_NAME}_bg.wasm"

if [ "$OPT" = 1 ]; then
  if command -v wasm-opt >/dev/null 2>&1; then
    # shellcheck disable=SC2086 # OPT_FLAGS is a list of flags
    if wasm-opt -Oz $OPT_FLAGS "$BG" -o "$BG.opt"; then
      mv "$BG.opt" "$BG"
    elif [ "$OPT_OPTIONAL" = 1 ]; then
      # The unoptimised artifact is correct, only larger; the size gate
      # below is the real check either way.
      echo "build-wasm: warning: wasm-opt failed; shipping the unoptimised artifact" >&2
      rm -f "$BG.opt"
    else
      die "wasm-opt failed on $BG"
    fi
  else
    echo "build-wasm: warning: wasm-opt not found; shipping unoptimised wasm (CI optimises)" >&2
  fi
fi

if [ -n "$HASH_MODULE" ]; then
  echo "$SOURCE_HASH" > "$OUT/SOURCE_HASH"
fi

SIZE=$(wc -c < "$BG" | tr -d ' ')
printf 'build-wasm: %s = %d bytes (%.2f MiB)\n' \
  "$BG" "$SIZE" "$(echo "$SIZE" | awk '{print $1/1048576}')"
if [ "$BROTLI" = 1 ] && command -v brotli >/dev/null 2>&1; then
  BR=$(brotli -q 11 -c "$BG" 2>/dev/null | wc -c | tr -d ' ')
  printf 'build-wasm: brotli transfer size = %d bytes (%.2f MiB)\n' \
    "$BR" "$(echo "$BR" | awk '{print $1/1048576}')"
fi
[ "$GATE" = 1 ] || exit 0

if [ "$SIZE" -gt "$BUDGET" ]; then
  die "$BG exceeds the 100 MB app wasm budget ($BUDGET bytes)"
fi
echo "build-wasm: within the app budget ($BUDGET bytes)"

# A manifest's maxBytes is tighter, and a host that honours it refuses a
# larger file; holding the build to it keeps the artifact from outgrowing its
# own declaration unnoticed.
if [ -n "$MANIFEST" ]; then
  MAX=$(bun -e '
    const [manifest, file] = process.argv.slice(1);
    const m = JSON.parse(require("fs").readFileSync(manifest, "utf8"));
    const w = (m.capabilities?.wasm ?? []).find((x) => x.path?.split("/").pop() === file);
    if (!w || !(w.maxBytes > 0)) process.exit(1);
    console.log(w.maxBytes);
  ' "$MANIFEST" "$(basename "$BG")") \
    || die "$MANIFEST declares no maxBytes for $(basename "$BG")"
  if [ "$SIZE" -gt "$MAX" ]; then
    die "$BG exceeds the manifest's maxBytes ($MAX bytes, $MANIFEST)"
  fi
  echo "build-wasm: within the manifest's maxBytes ($MAX bytes)"
fi
