#!/usr/bin/env bash
# bun fmt for this repository: Prettier 3's defaults (bunfig.toml [fmt]),
# minus what /.prettierignore lists.
#
#   tooling/js/fmt.sh [path ...]           format (the whole repository by default)
#   tooling/js/fmt.sh --check [path ...]   check only; exit 1 when a file needs formatting
#   tooling/js/fmt.sh --list [path ...]    print the files that need formatting
#   tooling/js/fmt.sh --staged             format the staged files and stage them
#                                          again (the pre-commit hook)
#
# Paths are relative to the current directory. --debug-check (fail if
# formatting would change what a file means) and --list-files run bun fmt's
# modes of those names, which write nothing. Other arguments that start
# with `-` go to bun fmt unchanged (for example --timing).
#
# Exit status is bun fmt's: 0 nothing to do; 1 a file needs formatting
# (--check, --list); 2 a file could not be formatted (a syntax error), a
# staged file also has unstaged changes (--staged), or the configuration is
# invalid. A check fails on 1 and on 2.
#
# Why a wrapper: bun fmt reads .prettierignore and the .gitignore of the
# directory it runs in, but not the nested .gitignore files, so on its own it
# would also format build outputs they exclude (wasm-bindgen glue, dist/).
# This script runs from the repository root and passes bun fmt exactly the
# files git lists (tracked, plus untracked files no .gitignore excludes).
# bun fmt still skips every file /.prettierignore names, even a named one,
# and files in a language it does not format (--ignore-unknown).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
canary="$here/bun-canary.sh"
root=$(git rev-parse --show-toplevel)

mode=()
flags=()
paths=()
for arg in "$@"; do
  case "$arg" in
    --staged)
      # Twice, for the files bun fmt formats to its fixed point only on a
      # second pass (see the end of this script); a no-op otherwise.
      cd "$root"
      "$canary" fmt --staged || exit $?
      s=0
      out=$("$canary" fmt --staged 2>&1) || s=$?
      [ "$s" -eq 0 ] || echo "$out" >&2
      exit "$s" ;;
    --check) mode=(--check) ;;
    --list) mode=(--list-different) ;;
    # bun fmt's other modes that write nothing
    --debug-check | --list-files | --list-different | -l) mode=("$arg") ;;
    -*) flags+=("$arg") ;;
    *) paths+=("$arg") ;;
  esac
done

# git's file list, as paths from the repository root.
files=()
if [ ${#paths[@]} -eq 0 ]; then
  cd "$root"
  list=(git ls-files -z --cached --others --exclude-standard)
else
  list=(git ls-files -z --full-name --cached --others --exclude-standard -- "${paths[@]}")
fi
while IFS= read -r -d '' f; do
  # --cached also lists files deleted in the working tree.
  [ -f "$root/$f" ] && files+=("$f")
done < <("${list[@]}")
cd "$root"

if [ ${#files[@]} -eq 0 ]; then
  echo "fmt.sh: no files under: ${paths[*]:-.}" >&2
  exit 0
fi

# bun fmt over all the files, one run per batch of paths to stay under the
# argument-length limit (1 MiB on macOS; the whole repository is one batch
# today). Returns the worst status of the batches.
fmt_all() {
  local status=0 s size=0 f
  local batch=()
  for f in "${files[@]}" ""; do
    if [ -n "$f" ]; then
      batch+=("$f")
      size=$((size + ${#f} + 1))
    fi
    if [ ${#batch[@]} -gt 0 ] && { [ -z "$f" ] || [ "$size" -gt 524288 ]; }; then
      s=0
      "$canary" fmt "$@" --ignore-unknown "${batch[@]}" || s=$?
      [ "$s" -gt "$status" ] && status=$s
      batch=()
      size=0
    fi
  done
  return "$status"
}

if [ ${#mode[@]} -gt 0 ]; then
  s=0
  fmt_all "${mode[@]}" ${flags[@]+"${flags[@]}"} || s=$?
  exit "$s"
fi

# Writing. bun fmt does not reach its fixed point in one pass on every file
# (a member chain can wrap differently the second time), so it formats again
# until a check passes: what this writes, --check accepts.
for pass in 1 2 3; do
  s=0
  if [ "$pass" -eq 1 ]; then
    fmt_all ${flags[@]+"${flags[@]}"} || s=$?
  else
    fmt_all ${flags[@]+"${flags[@]}"} >/dev/null || s=$?
  fi
  [ "$s" -eq 0 ] || exit "$s"
  s=0
  fmt_all --check >/dev/null 2>&1 || s=$?
  [ "$s" -eq 1 ] || exit "$s"
done
echo "fmt.sh: bun fmt reached no fixed point in 3 passes" >&2
exit 1
