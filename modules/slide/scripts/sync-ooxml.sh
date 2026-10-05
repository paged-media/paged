#!/usr/bin/env bash
# Vendored paged-ooxml (ADR 701): copy plugin-doc's crate in, or check the copy.
#   scripts/sync-ooxml.sh <plugin-doc checkout>   re-vendor and stamp
#   scripts/sync-ooxml.sh --check                 fail if vendor/ drifted from its stamp
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST="$ROOT/vendor/paged-ooxml"
tree_hash() { (cd "$1" && find Cargo.toml src -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1); }
if [[ "${1:-}" == "--check" ]]; then
  want=$(grep '^tree = ' "$DEST/SYNCED" | cut -d' ' -f3)
  have=$(tree_hash "$DEST")
  if [[ "$want" != "$have" ]]; then
    echo "vendor/paged-ooxml drifted from its stamp (want $want, have $have)." >&2
    echo "Edit paged-ooxml in plugin-doc, then re-run scripts/sync-ooxml.sh <plugin-doc>." >&2
    exit 1
  fi
  echo "vendor/paged-ooxml matches its stamp."
  exit 0
fi
SRC="${1:?usage: sync-ooxml.sh <plugin-doc checkout> | --check}"
rm -rf "$DEST/src" && mkdir -p "$DEST"
cp "$SRC/paged-ooxml/Cargo.toml" "$DEST/Cargo.toml"
cp -R "$SRC/paged-ooxml/src" "$DEST/src"
commit=$(git -C "$SRC" log -1 --format=%H -- paged-ooxml)
{
  sed '/^commit = /d;/^tree = /d' "$DEST/SYNCED" 2>/dev/null || true
  echo "commit = $commit"
  echo "tree = $(tree_hash "$DEST")"
} > "$DEST/SYNCED.new" && mv "$DEST/SYNCED.new" "$DEST/SYNCED"
echo "vendored paged-ooxml from plugin-doc@$commit"
