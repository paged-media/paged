#!/bin/sh
# A RAM disk for Cargo build output on macOS (docs/development/rust-builds.md,
# "RAM disk"). Its contents are gone on `down` or a reboot; memory is only
# used as Cargo writes to it.
#
#   tooling/dev/ramdisk.sh up [GB]   mount /Volumes/PagedTarget (default 48 GB)
#   tooling/dev/ramdisk.sh status    size and usage
#   tooling/dev/ramdisk.sh down      eject it
#
# Then point Cargo at it, e.g. `export CARGO_TARGET_DIR=/Volumes/PagedTarget/core`.
set -eu
name=PagedTarget
mount=/Volumes/$name
[ "$(uname -s)" = Darwin ] || { echo "macOS only"; exit 1; }

case "${1:-status}" in
  up)
    if [ -d "$mount" ]; then echo "$mount is already mounted"; exit 0; fi
    gb=${2:-48}
    # hdiutil counts 512-byte sectors.
    dev=$(hdiutil attach -nomount "ram://$((gb * 1024 * 1024 * 2))" | awk '{print $1}')
    diskutil erasevolume HFS+ "$name" "$dev" >/dev/null
    # Spotlight would index every build artifact.
    mdutil -i off "$mount" >/dev/null 2>&1 || true
    echo "mounted $mount ($gb GB, $dev)"
    echo "use it: export CARGO_TARGET_DIR=$mount/<workspace>"
    ;;
  status)
    if [ -d "$mount" ]; then df -h "$mount"; else echo "$mount is not mounted"; fi
    ;;
  down)
    if [ -d "$mount" ]; then diskutil eject "$mount"; else echo "$mount is not mounted"; fi
    ;;
  *)
    echo "usage: $0 up [GB] | status | down" >&2
    exit 2
    ;;
esac
