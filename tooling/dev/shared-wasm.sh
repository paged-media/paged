#!/usr/bin/env bash
# One engine wasm build, shared by every worktree on the machine.
#
# Building the engine's wasm (moon run core:wasm-pkg) takes a long time, and
# every worktree whose engine sources match main would build the same bytes.
# `publish` stores one build per commit in a shared directory; `use` copies it
# into a worktree whose engine sources are those of that commit.
#
#   tooling/dev/shared-wasm.sh publish [--dev|--release] [--no-build] [--force]
#   tooling/dev/shared-wasm.sh use [<commit>]
#   tooling/dev/shared-wasm.sh list
#
# publish   builds all four parts (engine/core/scripts/build-wasm-packages.sh
#           --workspace; --release, the default, is what CI ships, --dev the
#           fast local profile) and stores them under <dir>/<HEAD sha>/, with a
#           README.txt that says how they were built. The worktree's engine
#           sources must be HEAD's (no local edits). --no-build stores what is
#           already built; say which profile built it.
# use       copies a stored build into this worktree: packages/canvas-wasm/
#           (canvas, introspect/, repo/) and web/idml-viewer/wasm/ (the
#           session) under engine/core. Without <commit> it picks the stored
#           build whose engine sources equal this worktree's; with one, it
#           refuses unless they are equal.
# list      the stored builds, newest first.
#
# "Engine sources" are what the wasm is built from: engine/core (without its
# docs, Markdown, web/ and spikes/), platform/shared/fmt (a path dependency),
# and the root .cargo/config.toml, compared with `git diff` (committed and
# uncommitted changes) plus untracked files.
#
# The shared directory is PAGED_SHARED_WASM, by default
# ${XDG_CACHE_HOME:-$HOME/.cache}/paged/wasm. Layout:
#   <dir>/<sha>/README.txt
#   <dir>/<sha>/engine/core/packages/canvas-wasm/...
#   <dir>/<sha>/engine/core/web/idml-viewer/wasm/...
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIR="${PAGED_SHARED_WASM:-${XDG_CACHE_HOME:-$HOME/.cache}/paged/wasm}"
CORE=engine/core

# The generated files of each part, relative to the repository root.
GENERATED=(
  "$CORE/packages/canvas-wasm/paged_canvas_wasm.js"
  "$CORE/packages/canvas-wasm/paged_canvas_wasm.d.ts"
  "$CORE/packages/canvas-wasm/paged_canvas_wasm_bg.wasm"
  "$CORE/packages/canvas-wasm/paged_canvas_wasm_bg.wasm.d.ts"
  "$CORE/packages/canvas-wasm/introspect"
  "$CORE/packages/canvas-wasm/repo"
  "$CORE/web/idml-viewer/wasm"
)
SOURCES=(
  "$CORE" ":(exclude)$CORE/docs" ":(exclude)$CORE/**/*.md" ":(exclude)$CORE/web"
  ":(exclude)$CORE/spikes" "platform/shared/fmt" ".cargo/config.toml"
)

die() {
  echo "shared-wasm: $*" >&2
  exit 1
}

git_() { git -C "$ROOT" "$@"; }

# True when this worktree's engine sources equal <commit>'s.
sources_match() {
  git_ diff --quiet "$1" -- "${SOURCES[@]}" 2>/dev/null \
    && [ -z "$(git_ ls-files --others --exclude-standard -- "${SOURCES[@]}")" ]
}

cmd_list() {
  [ -d "$DIR" ] || { echo "shared-wasm: nothing stored in $DIR"; return 0; }
  local entry
  # shellcheck disable=SC2045 # the names are commit hashes
  for entry in $(ls -t "$DIR"); do
    [ -f "$DIR/$entry/README.txt" ] || continue
    printf '%s  %s\n' "${entry:0:12}" "$(head -1 "$DIR/$entry/README.txt")"
  done
}

cmd_publish() {
  local profile=release build=1 force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dev) profile=dev ;;
      --release) profile=release ;;
      --no-build) build=0 ;;
      --force) force=1 ;;
      *) die "publish: unknown option $1" ;;
    esac
    shift
  done
  local sha dest tmp
  sha=$(git_ rev-parse HEAD)
  sources_match HEAD || die "the engine sources differ from HEAD ($sha); commit or revert first"
  dest="$DIR/$sha"
  if [ -e "$dest" ] && [ "$force" = 0 ]; then
    die "$dest exists (--force replaces it)"
  fi
  if [ "$build" = 1 ]; then
    PAGED_WASM_PROFILE=$profile PAGED_WASM_PARTS="" \
      bash "$ROOT/$CORE/scripts/build-wasm-packages.sh" --workspace canvas introspect repo session
  fi
  local path
  for path in "${GENERATED[@]}"; do
    [ -e "$ROOT/$path" ] || die "$path is missing; build all four parts first"
  done
  mkdir -p "$DIR"
  tmp=$(mktemp -d "$DIR/.publish.XXXXXX")
  for path in "${GENERATED[@]}"; do
    mkdir -p "$tmp/$(dirname "$path")"
    cp -R "$ROOT/$path" "$tmp/$path"
  done
  {
    echo "$profile build of $(git_ log -1 --format='%h %cs %s' HEAD)"
    echo
    echo "commit:  $sha"
    echo "profile: $profile ($( [ "$profile" = dev ] && echo 'wasm-dev Cargo profile, no wasm-opt; not for shipping' || echo 'wasm-release, wasm-opt -Oz, as CI ships it'))"
    echo "built:   $(date -u '+%Y-%m-%dT%H:%M:%SZ') with $(cd "$ROOT/$CORE" && rustc --version 2>/dev/null || echo rustc), $(wasm-bindgen --version 2>/dev/null || echo wasm-bindgen)"
    echo "parts:   canvas, introspect, repo, session"
    echo
    echo "Use: tooling/dev/shared-wasm.sh use $sha"
    echo "(copies engine/ into a worktree whose engine sources equal this commit's)"
  } >"$tmp/README.txt"
  if [ -e "$dest" ]; then
    mv "$dest" "$tmp.old"
    mv "$tmp" "$dest"
    rm -rf "$tmp.old"
  else
    mv "$tmp" "$dest"
  fi
  echo "shared-wasm: published $profile build of $sha to $dest"
}

cmd_use() {
  [ -d "$DIR" ] || die "nothing stored in $DIR"
  local sha="" entry
  if [ $# -gt 0 ]; then
    sha=$(git_ rev-parse --verify --quiet "$1^{commit}") || die "unknown commit $1"
    [ -f "$DIR/$sha/README.txt" ] || die "no stored build of $sha in $DIR"
    sources_match "$sha" || die "this worktree's engine sources differ from $sha; build instead (moon run core:wasm-dev)"
  else
    # shellcheck disable=SC2045 # the names are commit hashes
    for entry in $(ls -t "$DIR"); do
      [ -f "$DIR/$entry/README.txt" ] || continue
      git_ cat-file -e "$entry^{commit}" 2>/dev/null || continue
      if sources_match "$entry"; then
        sha=$entry
        break
      fi
    done
    [ -n "$sha" ] || die "no stored build matches this worktree's engine sources (list: $0 list)"
  fi
  local path
  for path in "${GENERATED[@]}"; do
    [ -e "$DIR/$sha/$path" ] || continue
    # Replace only what a build generates; package.json, README and the
    # licence files beside them are committed and stay.
    case "$path" in
      */introspect | */repo)
        mkdir -p "$ROOT/$path"
        find "$ROOT/$path" -maxdepth 1 -name 'paged_*' -exec rm -rf {} +
        rm -rf "$ROOT/$path/snippets" "$ROOT/$path/catalog.json"
        cp -R "$DIR/$sha/$path/." "$ROOT/$path/"
        ;;
      */wasm)
        rm -rf "${ROOT:?}/$path"
        cp -R "$DIR/$sha/$path" "$ROOT/$path"
        ;;
      *) cp "$DIR/$sha/$path" "$ROOT/$path" ;;
    esac
  done
  echo "shared-wasm: copied $(head -1 "$DIR/$sha/README.txt")"
}

case "${1:-}" in
  publish) shift; cmd_publish "$@" ;;
  use) shift; cmd_use "$@" ;;
  list) cmd_list ;;
  *)
    sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
