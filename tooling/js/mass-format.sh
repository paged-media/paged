#!/usr/bin/env bash
# The one-time mass format to `bun fmt` (docs/migration/bun-fmt.md): one
# component per run, one commit per component, nothing in it but the
# formatter's output.
#
#   tooling/js/mass-format.sh --list                 components, and how many files each would change
#   tooling/js/mass-format.sh <component> [--trailer <t>]...
#                                                    format one component and commit it
#   tooling/js/mass-format.sh --record [--trailer <t>]...
#                                                    list the mass-format commits in
#                                                    .git-blame-ignore-revs, as a commit of its own
#
# Components: each directory under engine/, apps/, platform/ and modules/
# (engine/core, apps/editor, modules/sheet, ...), `tooling`, and `root`
# (everything else: the root files, docs/, .github/, .moon/, ...).
#
# A component's commit has the fixed subject
#   fmt: <component> (bun fmt, no other change)
# and `--record` appends every commit with such a subject that
# .git-blame-ignore-revs does not list yet, so `git blame` (and GitHub's
# blame view) skips them. Record after the commits are in their final place:
# a rebase gives them new hashes.
#
# Deterministic and idempotent: the formatter's output depends only on the
# tree, config and pinned version; a formatted component commits nothing, and
# a second --record finds nothing to add.
#
# Each run first proves the format keeps meaning (bun fmt --debug-check) and
# refuses to start on a dirty tree, so a commit can only hold formatter
# output. `--trailer` is passed to `git commit` unchanged.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"
fmt=tooling/js/fmt.sh
subject_re='^fmt: [^ ]+ \(bun fmt, no other change\)$'

die() { echo "mass-format: $*" >&2; exit 1; }

components() {
  local d
  for d in engine/*/ apps/*/ platform/*/ modules/*/; do
    [ -d "$d" ] && git ls-files --error-unmatch "$d" >/dev/null 2>&1 && echo "${d%/}"
  done
  echo tooling
  echo root
}

# The git pathspec of a component.
pathspec() {
  case "$1" in
    root)
      echo .
      echo ':(exclude)engine' ':(exclude)apps' ':(exclude)platform' \
        ':(exclude)modules' ':(exclude)tooling' | tr ' ' '\n' ;;
    *) echo "$1" ;;
  esac
}

clean_tree() {
  [ -z "$(git status --porcelain)" ] ||
    die "the working tree is not clean (git status --porcelain); commit or stash first"
}

trailers=()
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --trailer) [ $# -ge 2 ] || die "--trailer needs a value"; trailers+=(--trailer "$2"); shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
[ ${#args[@]} -eq 1 ] || die "usage: mass-format.sh --list | <component> | --record [--trailer <t>]..."
what=${args[0]}

case "$what" in
  --list)
    while read -r c; do
      spec=()
      while IFS= read -r p; do spec+=("$p"); done < <(pathspec "$c")
      n=$("$fmt" --list "${spec[@]}" 2>/dev/null | grep -c . || true)
      printf '%6s  %s\n' "$n" "$c"
    done < <(components)
    exit 0 ;;

  --record)
    clean_tree
    file=.git-blame-ignore-revs
    [ -f "$file" ] || cat > "$file" <<'EOF'
# Commits that only reformat, which `git blame` skips. GitHub reads this file
# by itself; for a local `git blame`, run once per clone:
#   git config blame.ignoreRevsFile .git-blame-ignore-revs
# tooling/js/mass-format.sh --record appends its commits here.
EOF
    added=0
    while IFS= read -r line; do
      sha=${line%% *}
      grep -q "^$sha$" "$file" && continue
      printf '\n# %s\n%s\n' "${line#* }" "$sha" >> "$file"
      added=$((added + 1))
    done < <(git log --reverse --format='%H %s' -E --grep="$subject_re")
    if [ "$added" -eq 0 ]; then
      git checkout -q -- "$file" 2>/dev/null || rm -f "$file"
      echo "mass-format: .git-blame-ignore-revs already lists every mass-format commit"
      exit 0
    fi
    git add "$file"
    git commit -q -m "fmt: .git-blame-ignore-revs lists the bun fmt commits" \
      -m "Adds $added commit(s) made by tooling/js/mass-format.sh, so git blame skips them." \
      ${trailers[@]+"${trailers[@]}"}
    echo "mass-format: recorded $added commit(s) in $file ($(git rev-parse --short HEAD))"
    exit 0 ;;
esac

c=$what
components | grep -x -- "$c" >/dev/null || die "unknown component '$c' (see --list)"
clean_tree
spec=()
while IFS= read -r p; do spec+=("$p"); done < <(pathspec "$c")

# Formatting must not change what any file means.
"$fmt" --debug-check "${spec[@]}" >/dev/null ||
  die "$c: bun fmt --debug-check failed; nothing was formatted"

# fmt.sh formats to the formatter's fixed point; the check proves it.
"$fmt" "${spec[@]}" >/dev/null && "$fmt" --check "${spec[@]}" >/dev/null || {
  git checkout -q -- .
  die "$c: bun fmt failed; the tree is restored"
}

[ -z "$(git ls-files --others --exclude-standard)" ] || die "$c: formatting created files"
if git diff --quiet; then
  echo "mass-format: $c is already formatted; nothing to commit"
  exit 0
fi

files=$(git diff --name-only | grep -c .)
git add -u
git commit -q -m "fmt: $c (bun fmt, no other change)" \
  -m "The output of tooling/js/fmt.sh over $c ($files files): bun $(tr -d '[:space:]' < tooling/js/bun-canary-version), bunfig.toml [fmt], /.prettierignore. Made by tooling/js/mass-format.sh; .git-blame-ignore-revs lists it." \
  ${trailers[@]+"${trailers[@]}"}
echo "mass-format: $c — $files files ($(git rev-parse --short HEAD))"
