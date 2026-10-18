#!/bin/sh
# Measures what macOS XProtect costs a freshly built binary: the first run of a
# new executable is scanned, later runs are not. Builds a tiny C program with a
# unique constant (so every probe is a new binary), runs it 3 times, prints ms.
# Run 1 minus run 2 is the scan cost; it grows while other new binaries wait
# in the same queue (docs/development/rust-builds.md, "XProtect").
set -eu
[ "$(uname -s)" = Darwin ] || { echo "macOS only"; exit 0; }
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
now() { perl -MTime::HiRes=time -e 'printf "%.1f", time * 1000'; }
printf 'int main(void){return %d == 0;}\n' "$$$(date +%s)" > "$dir/probe.c"
cc -O0 -o "$dir/probe" "$dir/probe.c"
for run in 1 2 3; do
  start=$(now)
  "$dir/probe" || true
  end=$(now)
  echo "run $run: $(perl -e "printf '%.1f', $end - $start") ms"
done
