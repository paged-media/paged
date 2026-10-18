#!/bin/sh
# Checks the tools the Rust builds use and prints how to install what is
# missing (docs/development/rust-builds.md). Exits 1 when a required tool is
# missing; recommended ones only warn.
set -u
missing=0
os=$(uname -s)

have() { command -v "$1" >/dev/null 2>&1; }
ok() { printf '  ok       %-14s %s\n' "$1" "$2"; }
need() { printf '  MISSING  %-14s install: %s\n' "$1" "$2"; missing=1; }
want() { printf '  missing  %-14s (recommended) install: %s\n' "$1" "$2"; }

echo "Required"
if have rustup; then ok rustup "$(rustup --version 2>/dev/null | head -1)"; else need rustup "https://rustup.rs"; fi
if have proto; then ok proto "$(proto --version)"; else need proto "curl -fsSL https://moonrepo.dev/install/proto.sh | bash"; fi
if have cargo-nextest; then ok cargo-nextest "$(cargo-nextest nextest --version 2>/dev/null | head -1)"
else
  if [ "$os" = Darwin ]; then need cargo-nextest "brew install cargo-nextest"; else need cargo-nextest "cargo install --locked cargo-nextest"; fi
fi
if [ "$os" = Darwin ]; then
  if xcode-select -p >/dev/null 2>&1; then ok clang "$(cc --version | head -1)"; else need clang "xcode-select --install"; fi
fi

echo "Recommended"
if have sccache; then ok sccache "$(sccache --version)"
else
  if [ "$os" = Darwin ]; then want sccache "brew install sccache"; else want sccache "cargo install --locked sccache"; fi
fi

if [ "$os" = Darwin ]; then
  echo "macOS"
  probe=$(dirname "$0")/xprotect-probe.sh
  first=$("$probe" | awk 'NR == 1 { print $3 }')
  ok XProtect "first run of a new binary: $first ms (malware scan; rust-builds.md, \"XProtect\")"
fi

exit "$missing"
